import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";
import { log } from "./logger";
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
    return { tag: complete[1], text: complete[2] };
  }
  const partial = text.match(/^\s*\[[a-zA-Z]*\s*([\s\S]*)$/);
  if (partial) {
    return { tag: null, text: partial[1] };
  }
  return { tag: null, text };
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
  ) {}

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
      `The user calls themselves "${user}".`,
      affinityLabel(this.config.affinity),
      "",
      "Rules:",
      "- Always stay in character. Never mention being an AI, a language model, an app or a program.",
      "- Keep replies short: one to three sentences, under 180 characters, unless the user explicitly asks for detail.",
      "- Warm, casual and slightly playful. Use emotes like (^-^) or :) sparingly.",
      "- React to what the user actually said; pick up on earlier details when it fits.",
      "- Never repeat your last line verbatim.",
      "- ALWAYS prefix your reply with ONE emotion tag in square brackets from this list: [happy], [blush], [pout], [surprised], [wink], [think], [neutral]. Choose the tag that best matches your emotional response.",
      "- Place the tag at the very beginning of your response, followed by a space and then your reply.",
      "- Example: '[happy] Glad to see you again~'",
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

    const messages: ChatMsg[] = [
      { role: "system", content: this.systemPrompt() },
      ...this.history,
    ];

    let full = "";
    let failure: string | null = null;
    log(`chat send: ${trimmed}`);

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
