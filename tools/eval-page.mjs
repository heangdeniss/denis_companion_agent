// Small helper: evaluate a JavaScript expression in the running app page.
// Usage: node tools/eval-page.mjs "expression"
import fs from "node:fs";

const PORT = 9222;
const expression = process.argv[2];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// Release builds serve the page from http://tauri.localhost, `tauri dev` from
// http://localhost:1420. Both are the app, and both expose `window.ei`.
const page = list.find(
  (t) => t.type === "page" && /^http:\/\/(tauri\.)?localhost/.test(t.url),
);
if (!page) throw new Error("page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const message = JSON.parse(e.data);
  const callback = pending.get(message.id);
  if (callback) {
    pending.delete(message.id);
    callback(message);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));
const send = (method, params) =>
  new Promise((resolve) => {
    const messageId = ++id;
    pending.set(messageId, resolve);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });

const result = await send("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
if (result.result?.exceptionDetails) {
  console.error(JSON.stringify(result.result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result.result?.result?.value ?? null, null, 2));
}
ws.close();
