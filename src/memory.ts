export type MemoryEntry = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
};

const MEM_KEY = "eiwaifu:memory";
const PREF_KEY = "eiwaifu:prefs";

function load(): MemoryEntry[] {
  try {
    const raw = localStorage.getItem(MEM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(entries: MemoryEntry[]): void {
  try {
    // Keep last 50 entries
    const trimmed = entries.slice(-50);
    localStorage.setItem(MEM_KEY, JSON.stringify(trimmed));
  } catch {}
}

export function getMemory(): MemoryEntry[] {
  return load();
}

export function addMemory(entry: Omit<MemoryEntry, "id" | "ts">): void {
  const entries = load();
  entries.push({
    id: Math.random().toString(36).slice(2),
    ts: Date.now(),
    ...entry,
  });
  save(entries);
}

export function clearMemory(): void {
  try {
    localStorage.removeItem(MEM_KEY);
  } catch {}
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

export function buildContextPrompt(): string {
  const entries = load().slice(-10);
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `${e.role}: ${e.content}`).join("\n");
  return `Recent conversation:\n${lines}\n\n`;
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
