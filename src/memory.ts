import { invoke } from "@tauri-apps/api/core";

export type MemoryEntry = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
};

/**
 * How many turns are kept. Each turn is one message, so 60 messages is about
 * 30 back-and-forth exchanges - enough to remember names and the last topics
 * without growing the prompt forever.
 */
const MAX_ENTRIES = 60;
/** How many entries are injected into the system prompt. */
const CONTEXT_ENTRIES = 16;

const MEM_KEY = "eiwaifu:memory";
const PREF_KEY = "eiwaifu:prefs";

/**
 * The memory lives in a JSON file in the app data folder, so it survives app
 * restarts *and* the switch between `npm run tauri dev` and the built exe
 * (the two run under different webview origins, so localStorage is not
 * shared between them).
 */
let cache: MemoryEntry[] = [];
let loaded = false;
let saveTimer: number | null = null;

function readLocalStorage(): MemoryEntry[] {
  try {
    const raw = localStorage.getItem(MEM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalStorage(entries: MemoryEntry[]): void {
  try {
    localStorage.setItem(MEM_KEY, JSON.stringify(entries));
  } catch {}
}

/** Loads the memory once at startup. Safe to call more than once. */
export async function initMemory(): Promise<void> {
  if (loaded) return;
  loaded = true;

  let entries: MemoryEntry[] = [];
  try {
    const file = await invoke<MemoryEntry[]>("load_memory");
    if (Array.isArray(file)) entries = file;
  } catch {
    // The command is missing in an older build: fall back to localStorage.
  }

  if (entries.length === 0) {
    entries = readLocalStorage();
    // Migrate whatever the old build stored in localStorage into the file.
    if (entries.length > 0) {
      cache = entries.slice(-MAX_ENTRIES);
      scheduleSave();
      return;
    }
  }

  cache = entries.slice(-MAX_ENTRIES);
}

export function getMemory(): MemoryEntry[] {
  return cache;
}

export function hasMemory(): boolean {
  return cache.some((e) => e.role !== "system" && e.content.trim().length > 0);
}

export function addMemory(entry: Omit<MemoryEntry, "id" | "ts">): void {
  if (!entry.content.trim()) return;
  cache.push({
    id: Math.random().toString(36).slice(2),
    ts: Date.now(),
    ...entry,
  });
  if (cache.length > MAX_ENTRIES) {
    cache = cache.slice(-MAX_ENTRIES);
  }
  scheduleSave();
}

function scheduleSave(): void {
  // Coalesce the writes of a streaming reply into one file write.
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushMemory();
  }, 400);
}

export async function flushMemory(): Promise<void> {
  const snapshot = cache.slice(-MAX_ENTRIES);
  writeLocalStorage(snapshot);
  try {
    await invoke("save_memory", { entries: snapshot });
  } catch {}
}

export function clearMemory(): void {
  cache = [];
  try {
    localStorage.removeItem(MEM_KEY);
  } catch {}
  void flushMemory();
}

/** Everything she should remember about the user, as prompt text. */
export function buildContextPrompt(): string {
  if (cache.length === 0) return "";
  const recent = cache.slice(-CONTEXT_ENTRIES);
  const facts = cache.filter((e) => e.role === "system").slice(-12);
  const lines = recent
    .filter((e) => e.role !== "system")
    .map((e) => `${e.role === "user" ? "User" : "You"}: ${e.content}`)
    .join("\n");

  const parts: string[] = [];
  if (lines) {
    parts.push(`Recent conversation (oldest first):\n${lines}`);
  }
  if (facts.length) {
    parts.push(
      "Facts about the user (the most recent value wins; trust these over the conversation above if they disagree):\n" +
        facts.map((f) => `- ${f.content}`).join("\n"),
    );
  }
  return parts.join("\n\n") + "\n\n";
}

/**
 * Stores a durable fact and replaces an older value for the same label, so
 * "my favourite colour is black" overwrites the earlier "blue" instead of
 * leaving two contradictory lines in the memory.
 */
export function rememberFact(label: string, value: string): void {
  const clean = value.trim().replace(/[.!?,]+$/, "");
  if (!clean) return;
  const tag = `the user's ${label.toLowerCase()} is `;
  cache = cache.filter(
    (entry) => !(entry.role === "system" && entry.content.toLowerCase().startsWith(tag)),
  );
  addMemory({ role: "system", content: `The user's ${label} is ${clean}.` });
}

/**
 * Pulls simple, explicitly stated preferences out of a message, e.g.
 * "my favourite colour is black" or "my favorite food is ramen".
 */
export function detectFacts(
  text: string,
): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  const match = text.match(
    /\bmy\s+favou?rite\s+([a-z][a-z ]{0,18}?)\s+(?:is|are)\s+([a-z0-9][a-z0-9' -]{0,24})/i,
  );
  if (match) {
    const label = match[1]
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\bcolor\b/g, "colour")
      .toLowerCase();
    let value = match[2].trim();
    // Drop trailing clauses such as "but only on Tuesdays".
    value = value.split(/\s+(?:but|and|because|not|though|unless)\b/i)[0].trim();
    if (value) facts.push({ label: `favourite ${label}`, value });
  }
  return facts;
}

/**
 * Answers a direct question about the user from the stored facts, so a small
 * model cannot get a remembered preference wrong. Returns the sentence only
 * (without the emotion tag), or null when the model should handle the turn.
 */
export function findFactAnswer(text: string): string | null {
  const norm = (value: string) =>
    value
      .toLowerCase()
      .replace(/\bfavorite\b/g, "favourite")
      .replace(/\bcolor\b/g, "colour");

  const message = norm(text);
  const asksAboutUser = /\bmy\b|\bme\b|\bi\b/.test(message);
  const asksQuestion =
    message.includes("?") ||
    /\b(?:what|which|who|do you (?:know|remember)|tell me)\b/.test(message);
  if (!asksAboutUser || !asksQuestion) return null;

  if (/\bmy name\b|\bwho am i\b|know my name/.test(message)) {
    const name = recallUserName();
    if (name) return `Your name is ${name}.`;
  }

  const facts = cache.filter((entry) => entry.role === "system");
  for (let i = facts.length - 1; i >= 0; i--) {
    const match = facts[i].content.match(
      /^The user's (favourite [a-z ]+) is (.+?)\.?$/i,
    );
    if (!match) continue;
    const label = norm(match[1].trim());
    if (message.includes(`my ${label}`) || message.includes(label)) {
      return `Your ${label} is ${match[2]}.`;
    }
  }
  return null;
}

/** Extracts a name the user gives about themselves. */
export function detectUserName(text: string): string | null {
  const match = text.match(
    /\b(?:my name is|call me|i am|i'm)\s+([a-zA-Z][a-zA-Z'-]{1,20})\b/i,
  );
  if (!match) return null;
  const name = match[1];
  // "I'm tired" is not a name. Ignore the obvious everyday words.
  const notNames = new Set([
    "tired", "hungry", "fine", "good", "great", "sad", "happy", "ok", "okay",
    "here", "back", "sorry", "bored", "busy", "sleepy", "angry", "sure",
    "not", "just", "still", "really", "so", "very", "your", "the", "a",
  ]);
  if (notNames.has(name.toLowerCase())) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Finds the user's name in the saved memory. Only trusts a stored fact or
 * something the user said, never a line from the model.
 */
export function recallUserName(): string | null {
  const facts = cache.filter((e) => e.role === "system");
  for (let i = facts.length - 1; i >= 0; i--) {
    const match = facts[i].content.match(/user'?s? name is ([A-Za-z][A-Za-z'-]{1,20})/i);
    if (match) return match[1];
  }
  for (let i = cache.length - 1; i >= 0; i--) {
    const entry = cache[i];
    if (entry.role === "system") continue;
    if (entry.role === "user") {
      const name = detectUserName(entry.content);
      if (name) return name;
    }
  }
  return null;
}

export function getPrefs(): any {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setPrefs(prefs: any): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {}
}

export function getTimeGreeting(): string | null {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning~ Hope you have a nice day!";
  if (h >= 12 && h < 18) return "Good afternoon~ How's your day going?";
  if (h >= 18 && h < 23) return "Good evening~ Want to chat for a bit?";
  if (h >= 0 && h < 5) return "Working late? Don't forget to rest your eyes!";
  return null;
}

export async function checkBattery(onLow: (msg: string) => void): Promise<void> {
  try {
    const nav: any = navigator as any;
    if (nav.getBattery) {
      const battery = await nav.getBattery();
      const check = () => {
        if (battery.level <= 0.2 && !battery.charging) {
          onLow("Battery low~ Maybe time to charge up!");
        }
      };
      check();
      battery.addEventListener("levelchange", check);
      battery.addEventListener("chargingchange", check);
    }
  } catch {}
}
