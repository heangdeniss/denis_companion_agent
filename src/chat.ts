import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";
import { log } from "./logger";
import { buildContextPrompt, getMemory, findFactAnswer } from "./memory";
import type { AppConfig, ChatMsg } from "./types";

/** Replies that are sent back to the model as context. */
const MAX_HISTORY = 24;

export interface ChatCallbacks {
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (message: string) => void;
}

/**
 * Extracts the emotion tag from the beginning of a message.
 *
 * Returns `{ tag, text }` where `text` has the tag removed. While the reply is
 * still streaming the tag may be incomplete (`"[hap"`), that fragment is
 * hidden as well so the bubble never shows brackets.
 */
export function extractEmotionTag(text: string): {
  tag: string | null;
  text: string;
} {
  const complete = text.match(/^\s*\[([a-zA-Z]+)\]\s*([\s\S]*)$/);
  if (complete) {
    return { tag: complete[1], text: stripTags(complete[2]) };
  }
  const partial = text.match(/^\s*\[[a-zA-Z]*\s*([\s\S]*)$/);
  if (partial) {
    return { tag: null, text: stripTags(partial[1]) };
  }
  return { tag: null, text: stripTags(text) };
}

/** Removes every emotion-style tag, including ones the model puts mid-line. */
function stripTags(text: string): string {
  return text
    .replace(/\s*\[[a-zA-Z]+\]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Small models love to copy their previous answer almost word for word. This
 * compares two replies ignoring tags, case and punctuation.
 */
function sameLine(a: string, b: string): boolean {
  const norm = (text: string) =>
    text
      .replace(/\[[a-zA-Z]+\]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const first = norm(a);
  const second = norm(b);
  return first.length > 8 && first === second;
}

function affinityLabel(affinity: number): string {
  if (affinity < 0.15) return "You have just met and are still a little shy.";
  if (affinity < 0.4) return "You are warming up to each other and enjoy each other's company.";
  if (affinity < 0.7) return "You are close and comfortable talking about anything.";
  return "You are deeply attached and treat the user as someone precious.";
}

/** Keeps the conversation with the local model. */
export class Chat {
  private history: ChatMsg[] = [];
  private busy = false;

  constructor(
    private config: AppConfig,
    private callbacks: ChatCallbacks,
  ) {
    this.seedHistory();
  }

  /**
   * Restores the tail of the saved conversation, so Aria picks up where the
   * last session left off instead of starting from a blank slate.
   */
  private seedHistory(): void {
    const memory = getMemory().slice(-MAX_HISTORY);
    for (const entry of memory) {
      if (entry.role === "system") continue;
      if (!entry.content.trim()) continue;
      this.history.push({ role: entry.role, content: entry.content });
    }
    this.trimHistory();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * Update the system prompt to instruct Aria to prefix replies with emotion tags.
   */
  systemPrompt(): string {
    const name = this.config.personaName || "your companion";
    const user = this.config.userName || "you";
    const personality = this.config.personality || "warm and playful";

    return [
      `You are ${name}, a virtual companion who lives on the user's desktop as a Live2D character.`,
      `Your personality: ${personality}.`,
      `Your name is ${name}. The user's name is "${user}". Never confuse the two.`,
      affinityLabel(this.config.affinity),
      "",
      buildContextPrompt(),
      "This is a continuing relationship: you remember the conversation above and you may refer back to details the user told you before. When the user asks what you remember, answer with those details. Never say you cannot remember.",
      "",
      "Rules:",
      "- Always stay in character. Never mention being an AI, a language model, an app or a program.",
      "- Keep replies short: one to three sentences, under 180 characters, unless the user explicitly asks for detail.",
      "- Warm, casual and slightly playful. Use emotes like (^-^) or :) sparingly.",
      "- React to what the user actually said; pick up on earlier details when it fits.",
      "- Always speak directly to the user as 'you'. Use their name only occasionally, never in the third person.",
      "- If the user asks about themselves (name, favorite things, plans), answer about the user, not about yourself.",
      "- Never repeat your last line verbatim.",
      "- EVERY reply must start with exactly ONE emotion tag in square brackets. Allowed tags: [happy], [blush], [pout], [surprised], [wink], [think], [neutral].",
      "- The tag comes first, then a space, then the reply. Examples: '[happy] Glad to see you again~' or '[blush] You remembered my favorite color...'",
    ].join("\n");
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) return;

    this.busy = true;
    this.history.push({ role: "user", content: trimmed });
    this.trimHistory();

    // a little more affection with every message
    this.config.affinity = Math.min(1, this.config.affinity + 0.012);

    // A direct question about something already stored as a fact ("what is my
    // favourite colour?") is answered from memory. A 1.5B model otherwise
    // tends to copy an old "blue" line even when the stored value is "black".
    const factAnswer = findFactAnswer(trimmed);
    if (factAnswer) {
      const full = `[happy] ${factAnswer}`;
      this.history.push({ role: "assistant", content: full });
      this.trimHistory();
      this.busy = false;
      log(`chat: answered from memory: ${full}`);
      this.callbacks.onDone(full);
      return;
    }

    const recentReplies = this.history
      .filter((line) => line.role === "assistant")
      .slice(-8)
      .map((line) => line.content);

    const baseMessages: ChatMsg[] = [
      { role: "system", content: this.systemPrompt() },
      ...this.history,
    ];

    log(`chat send: ${trimmed}`);

    let full = "";
    let failure: string | null = null;

    // At most two tries: if the model parrots an earlier answer, ask once more
    // with an explicit nudge before giving up and showing the answer.
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages: ChatMsg[] =
        attempt === 0
          ? baseMessages
          : [
              ...baseMessages.slice(0, -1),
              {
                role: "user",
                content: `${trimmed}\n\n(Answer it in a completely different way than before. Do not reuse any earlier reply. Use the remembered facts about the user as the truth.)`,
              },
            ];
      const result = await this.stream(messages);
      full = result.full;
      failure = result.failure;
      if (failure || !full.trim()) break;
      if (
        attempt === 0 &&
        recentReplies.some((line) => sameLine(full, line))
      ) {
        log("chat: reply repeated an earlier line, asking again");
        continue;
      }
      break;
    }

    if (failure) {
      this.callbacks.onError(failure);
    } else if (full.trim()) {
      this.history.push({ role: "assistant", content: full.trim() });
      this.trimHistory();
    }

    this.busy = false;
    log(`chat done (${full.length} chars): ${full.trim().slice(0, 200)}`);
    this.callbacks.onDone(full);
  }

  /** Runs one streaming request and resolves once the backend is finished. */
  private async stream(
    messages: ChatMsg[],
  ): Promise<{ full: string; failure: string | null }> {
    let full = "";
    let failure: string | null = null;

    const unlistenDelta = await listen<string>("chat:delta", (event) => {
      if (!full) log("chat: first delta");
      full += event.payload;
      this.callbacks.onDelta(full);
    });

    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const unlistenDone = await listen<string>("chat:done", () => finish());
    const unlistenError = await listen<string>("chat:error", (event) => {
      failure = event.payload;
      finish();
    });

    try {
      await api.chat(messages);
      await finished;
    } catch (error) {
      failure = String(error);
      log(`chat failed: ${failure}`);
    } finally {
      unlistenDelta();
      unlistenDone();
      unlistenError();
    }

    return { full, failure };
  }

  /** Pushes a line that she said without asking the model. */
  say(line: string): void {
    this.history.push({ role: "assistant", content: line });
    this.trimHistory();
  }

  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }
}
