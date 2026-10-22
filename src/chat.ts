import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";
import { log } from "./logger";
import type { AppConfig, ChatMsg } from "./types";

export interface ChatCallbacks {
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (message: string) => void;
}

const MAX_HISTORY = 24;

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
