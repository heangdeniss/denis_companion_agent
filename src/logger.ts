import { invoke } from "@tauri-apps/api/core";

/**
 * Mirrors the browser console into the application log file on disk. The
 * window is transparent and frameless, so the usual "look at the devtools"
 * workflow is not always available.
 */
let hooked = false;

export function log(message: string, ...rest: unknown[]): void {
  const extra = rest.length ? ` ${rest.map(stringify).join(" ")}` : "";
  const line = `${message}${extra}`;
  void invoke("log_line", { msg: line }).catch(() => {
    /* logging must never break the app */
  });
}

function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Installs the console bridge. Safe to call more than once. */
export function installConsoleBridge(): void {
  if (hooked) return;
  hooked = true;

  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      log(`[${level}]`, ...args);
    };
  }

  window.addEventListener("error", (event) => {
    log(`[uncaught] ${event.message} @ ${event.filename}:${event.lineno}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    log(`[unhandled] ${stringify(event.reason)}`);
  });
}
