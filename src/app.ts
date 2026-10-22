import { listen } from "@tauri-apps/api/event";
import { Application } from "pixi.js";
import { Character } from "./character";
import { Chat } from "./chat";
import { api } from "./ipc";
import { log } from "./logger";
import type { AppConfig, Rect } from "./types";

const POLL_INTERVAL = 40;

const GREETINGS = [
  "Hi~ You're finally here.",
  "Hey! What are we doing today?",
  "I was waiting for you (^-^)",
  "You look busy... want a small break?",
  "Good to see you again!",
];

const HEAD_REACTIONS = [
  "H-hey! That tickles~",
  "Ehehe, careful~",
  "Aaaa, that's ticklish!",
  "You always make me blush...",
];

const BODY_REACTIONS = [
  "W-wha?!",
  "Hey, not so sudden!",
  "H-hey! I'm right here, you know.",
  "S-stop that (^-^)",
];

const IDLE_REACTIONS = ["Hm?", "What is it?", "I'm listening~"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export async function bootstrap(): Promise<void> {
  const config: AppConfig = await api.getConfig();
  log("boot: config loaded", config);

  const stageEl = document.getElementById("stage") as HTMLDivElement;
  const bubbleEl = document.getElementById("bubble") as HTMLDivElement;
  const bubbleText = document.getElementById("bubble-text") as HTMLSpanElement;
  const chatEl = document.getElementById("chat") as HTMLElement;
  const chatLog = document.getElementById("chat-log") as HTMLDivElement;
  const chatForm = document.getElementById("chat-form") as HTMLFormElement;
  const chatInput = document.getElementById("chat-input") as HTMLInputElement;
  const chatName = document.getElementById("chat-name") as HTMLSpanElement;
  const chatClose = document.getElementById("chat-close") as HTMLButtonElement;
  const toastEl = document.getElementById("toast") as HTMLDivElement;

  chatName.textContent = config.personaName || "Companion";

  // ---------------------------------------------------------------- pixi app
  const canvas = document.createElement("canvas");
  const app = new Application({
    view: canvas,
    backgroundAlpha: 0,
    background: 0x000000,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    resizeTo: stageEl,
  });
  (app.renderer as any).roundPixels = true;
  stageEl.appendChild(canvas);

  const character = new Character(app, {
    onTap: (areas) => handleTap(areas),
  });

  // ---------------------------------------------------------------- model
  const models = await api.listModels();
  log(`models found: ${models.length}`, models);
  if (!models.length) {
    showToast("No Live2D model found. Put one in the models folder.");
    return;
  }

  const entry =
    models.find((m) => m.name === config.selectedModel) ?? models[0];
  config.selectedModel = entry.name;

  const base = await api.modelBaseUrl();
  const modelUrl = base + entry.file.split("/").map(encodeURIComponent).join("/");
  log(`loading model: ${modelUrl}`);

  try {
    await character.load(modelUrl);
    log("model loaded");
  } catch (error) {
    log(`model load failed: ${error}`);
    showToast(`Could not load model: ${error}`);
    return;
  }

  character.userScale = config.scale;
  character.applyScale();
  app.ticker.add(() => character.tick());
  app.renderer.on("resize", () => character.applyScale());

  // ---------------------------------------------------------------- ui
  let bubbleTimer: number | undefined;
  function showBubble(text: string, seconds = config.bubbleSeconds): void {
    bubbleText.textContent = text;
    bubbleEl.hidden = false;
    window.clearTimeout(bubbleTimer);
    bubbleTimer = window.setTimeout(() => {
      bubbleEl.hidden = true;
    }, Math.max(1500, seconds * 1000));
  }

  let toastTimer: number | undefined;
  function showToast(text: string): void {
    toastEl.textContent = text;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, 5000);
  }

  function logMessage(text: string, who: "user" | "her" | "system"): void {
    const div = document.createElement("div");
    div.className = `msg ${who}`;
    div.textContent = text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function toggleChat(force?: boolean): void {
    const show = force ?? chatEl.hidden;
    chatEl.hidden = !show;
    log(`chat panel ${show ? "opened" : "closed"}`);
    if (show) {
      chatInput.focus();
    }
    void updateClickRegion(true);
  }

  // ---------------------------------------------------------------- chat
  const chat = new Chat(config, {
    onDelta: (text) => {
      character.setMouthOpen(0.75);
      showBubble(text, Math.max(4, config.bubbleSeconds));
    },
    onDone: (full) => {
      if (full.trim()) {
        logMessage(full.trim(), "her");
        showBubble(full.trim(), Math.max(4, config.bubbleSeconds));
      }
      void api.setConfig(config);
    },
    onError: (message) => {
      logMessage(`[error] ${message}`, "system");
      showToast(message);
    },
  });

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = chatInput.value;
    if (!text.trim()) return;
    chatInput.value = "";
    logMessage(text, "user");
    void chat.send(text);
  });

  chatClose.addEventListener("click", () => toggleChat(false));

  await listen("menu:toggle-chat", () => toggleChat());
  await listen<string>("menu:open-models", (event) => {
    void api.openPath(event.payload);
  });
  await listen<string>("menu:open-config", (event) => {
    void api.openPath(event.payload);
  });

  // ---------------------------------------------------------------- tapping
  function handleTap(areas: string[]): void {
    const lower = areas.map((a) => a.toLowerCase());

    if (lower.some((a) => a.includes("head"))) {
      character.motion("TapBody", 0, 3);
      character.expression("F05");
      const line = pick(HEAD_REACTIONS);
      chat.say(line);
      showBubble(line);
      void updateClickRegion(true);
    } else if (lower.some((a) => a.includes("body"))) {
      character.motion("TapBody", 1, 3);
      character.expression("F03");
      const line = pick(BODY_REACTIONS);
      chat.say(line);
      showBubble(line);
      void updateClickRegion(true);
    } else {
      const line = pick(IDLE_REACTIONS);
      chat.say(line);
      showBubble(line);
      void updateClickRegion(true);
    }
  }

  // ---------------------------------------------------------------- pointer
  let pointerDown = false;
  let pointerMoved = false;
  let dragOrigin = { x: 0, y: 0 };
  let windowOrigin = { x: 0, y: 0 };
  let dragging = false;

  canvas.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0) return;

    // The drag origin has to be known *before* the button is considered down,
    // otherwise the poll loop can start dragging the window with stale values
    // and the window jumps to the cursor.
    const cursor = await api.cursorPos();
    const bounds = await api.windowBounds();
    dragOrigin = { x: cursor.x, y: cursor.y };
    windowOrigin = { x: bounds.x, y: bounds.y };

    pointerDown = true;
    pointerMoved = false;
    dragging = false;
    log(`pointerdown at ${event.clientX.toFixed(0)},${event.clientY.toFixed(0)}`);

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* capture is optional */
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointerDown) return;
    if (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1) {
      pointerMoved = true;
    }
  });

  canvas.addEventListener("pointerup", async (event) => {
    pointerDown = false;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    if (!pointerMoved) {
      const rect = canvas.getBoundingClientRect();
      const areas = character.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      handleTap(areas);
    }
  });

  canvas.addEventListener("dblclick", () => toggleChat());

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.92 : 1.08;
      config.scale = clamp(config.scale * factor, 0.55, 4.5);
      character.userScale = config.scale;
      character.applyScale();
      void api.setConfig(config);
    },
    { passive: false },
  );

  // ---------------------------------------------------------------- click through
  // The window is only allowed to react to the mouse where the character and
  // the ui are visible. Everywhere else the click goes through to whatever is
  // behind the window. This is done with a window region, because the
  // WebView2 child windows would swallow the clicks otherwise.
  let regionVersion = -1;
  let regionRectsCount = 0;
  let lastRegionUpdate = 0;
  const REGION_MIN_INTERVAL = 140;

  function uiRects(): Rect[] {
    const rects: Rect[] = [];
    for (const el of [chatEl, bubbleEl, toastEl]) {
      if (el.hidden) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      rects.push({
        x: Math.floor(box.left),
        y: Math.floor(box.top),
        w: Math.ceil(box.width),
        h: Math.ceil(box.height),
      });
    }
    return rects;
  }

  async function updateClickRegion(force = false): Promise<void> {
    const now = performance.now();
    if (!force && pointerDown) return;
    if (!force && character.maskVersion === regionVersion && now - lastRegionUpdate < REGION_MIN_INTERVAL) return;
    if (!force && character.maskVersion === regionVersion) return;
    regionVersion = character.maskVersion;
    lastRegionUpdate = now;

    const rects = config.clickThrough
      ? [...character.regionRects(), ...uiRects()]
      : [];
    regionRectsCount = rects.length;
    try {
      await api.setClickRegion(rects);
    } catch (error) {
      console.error("could not update the click region", error);
    }
  }

  // ---------------------------------------------------------------- polling
  let lastCursor = { x: 0, y: 0 };

  window.setInterval(async () => {
    try {
      const [cursor, bounds] = await Promise.all([
        api.cursorPos(),
        api.windowBounds(),
      ]);

      // Dragging is decided from the movement between two polls, because the
      // pointer coordinates shift while the window itself is being moved.
      if (pointerDown && !dragging) {
        const moved =
          Math.abs(cursor.x - lastCursor.x) > 2 ||
          Math.abs(cursor.y - lastCursor.y) > 2;
        if (moved) dragging = true;
      }
      lastCursor = cursor;

      if (dragging) {
        await api.setWindowPosition(
          windowOrigin.x + (cursor.x - dragOrigin.x),
          windowOrigin.y + (cursor.y - dragOrigin.y),
        );
        return;
      }

      const sx = (cursor.x - bounds.x) / bounds.scaleFactor;
      const sy = (cursor.y - bounds.y) / bounds.scaleFactor;

      character.focus(sx, sy);

      // While the mouse is held down the region must not change, otherwise
      // the window would lose the cursor in the middle of a drag.
      if (!pointerDown) {
        await updateClickRegion();
      }
    } catch (error) {
      console.error("poll failed", error);
    }
  }, POLL_INTERVAL);

  // ---------------------------------------------------------------- startup
  const backend = await api.detectBackend();
  log("backend detected", backend);
  if (backend.error) {
    showToast(backend.error);
  } else {
    logMessage(
      `Connected to ${backend.provider} (${backend.activeModel})`,
      "system",
    );
  }

  if (config.greetOnStart) {
    const line = pick(GREETINGS);
    chat.say(line);
    showBubble(line);
  }

  // A heartbeat makes it easy to see from the log that the render loop and
  // the model are still alive.
  window.setInterval(() => {
    const ratio = character.maskPixels
      ? (character.opaquePixels / character.maskPixels) * 100
      : 0;
    const model = character.model;
    log(
      `heartbeat: fps=${app.ticker.FPS.toFixed(0)} opaque=${character.opaquePixels}/${character.maskPixels} (${ratio.toFixed(1)}%) region=${regionRectsCount} model=${model ? `${model.scale.x.toFixed(3)}@${model.position.x.toFixed(0)},${model.position.y.toFixed(0)}` : "none"}`,
    );
  }, 5000);

  log("ready");
}
