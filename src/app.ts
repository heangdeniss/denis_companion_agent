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
  const menuEl = document.getElementById("menu") as HTMLDivElement;
  const menuHide = document.getElementById("menu-hide") as HTMLButtonElement;
  const menuChat = document.getElementById("menu-chat") as HTMLButtonElement;
  const menuQuit = document.getElementById("menu-quit") as HTMLButtonElement;

  chatName.textContent = config.personaName || "Companion";

  // The timers have to exist before the first toast or bubble is shown. The
  // error paths below run before the ui section, and a `let` that is read
  // before its declaration throws a temporal dead zone error.
  let bubbleTimer: number | undefined;
  let toastTimer: number | undefined;

  // ---------------------------------------------------------------- pixi app
  // Render at least 2x the device pixel ratio. The model is painted at a
  // fraction of the window size, so supersampling keeps her silhouette and
  // the soft edges of the artwork smooth instead of stair-stepped.
  const dpr = window.devicePixelRatio || 1;
  const renderResolution = Math.min(3, Math.max(2, dpr));
  log(`renderer: ${renderResolution}x (device pixel ratio ${dpr})`);

  const canvas = document.createElement("canvas");
  const app = new Application({
    view: canvas,
    backgroundAlpha: 0,
    background: 0x000000,
    antialias: true,
    resolution: renderResolution,
    autoDensity: true,
    resizeTo: stageEl,
    powerPreference: "high-performance",
  });
  // Sub-pixel positions keep the slow live2d motion smooth. Rounding to whole
  // pixels made the character jitter by a pixel while she was breathing.
  (app.renderer as any).roundPixels = false;
  stageEl.appendChild(canvas);

  const character = new Character(app, {
    onTap: (areas) => handleTap(areas),
  });

  // ---------------------------------------------------------------- model
  const models = await api.listModels();
  log(`models found: ${models.length}`, models);
  if (!models.length) {
    showToast("No Live2D model found. Put one in the models folder.");
    await makeWindowInert();
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
    await makeWindowInert();
    return;
  }

  character.userScale = config.scale;
  character.applyScale();
  app.ticker.add(() => character.tick());
  app.renderer.on("resize", () => {
    character.applyScale();
    layoutBubble();
    layoutChat();
  });

  // ---------------------------------------------------------------- ui
  /**
   * Both dialogue surfaces float above her head. The anchor comes from the
   * alpha silhouette, so it follows the pose and the zoom level instead of
   * sitting at a fixed window offset (which could overlap her body).
   */
  function layoutBubble(): void {
    if (bubbleEl.hidden) return;
    const anchor = character.headAnchor();
    const gap = 10;
    const width = bubbleEl.offsetWidth;
    const height = bubbleEl.offsetHeight;
    // Place the bubble's bottom edge just above the actual head top, with
    // a tiny margin. Clamping to the top only happens if there's no room.
    const top = Math.max(4, Math.round(anchor.y - gap - height));
    const minX = 8 + width / 2;
    const maxX = window.innerWidth - 8 - width / 2;
    const x = Math.min(Math.max(anchor.x, minX), Math.max(minX, maxX));
    bubbleEl.style.left = `${Math.round(x)}px`;
    bubbleEl.style.top = `${top}px`;
    bubbleEl.style.transform = "translateX(-50%)";
  }

  function layoutChat(): void {
    if (chatEl.hidden) return;
    const anchor = character.headAnchor();
    const gap = 12;
    // Keep the whole panel inside the window while its bottom edge rests
    // just above her head.
    const available = Math.max(100, Math.round(anchor.y - gap - 6));
    chatEl.style.maxHeight = `${available}px`;
    const width = chatEl.offsetWidth;
    const height = chatEl.offsetHeight;
    const top = Math.max(6 + height, Math.round(anchor.y - gap));
    const minX = 8 + width / 2;
    const maxX = window.innerWidth - 8 - width / 2;
    const x = Math.min(Math.max(anchor.x, minX), Math.max(minX, maxX));
    chatEl.style.left = `${Math.round(x)}px`;
    chatEl.style.top = `${top}px`;
    chatEl.style.transform = "translate(-50%, -100%)";
  }

  function showBubble(text: string, seconds = config.bubbleSeconds): void {
    // While the chat is open the same line is already in the log, and both
    // panels would compete for the space above her head.
    if (!chatEl.hidden) return;
    bubbleText.textContent = text;
    bubbleEl.hidden = false;
    layoutBubble();
    window.clearTimeout(bubbleTimer);
    bubbleTimer = window.setTimeout(() => {
      bubbleEl.hidden = true;
    }, Math.max(1500, seconds * 1000));
  }

  function showToast(text: string): void {
    toastEl.textContent = text;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, 5000);
  }

  /**
   * A window without a character is invisible but would still swallow every
   * click in its area. Making it click-through keeps the desktop usable.
   */
  async function makeWindowInert(): Promise<void> {
    try {
      await api.setPassthrough(true);
    } catch {
      /* not critical */
    }
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
      bubbleEl.hidden = true;
      layoutChat();
      chatInput.focus();
    }
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

  // ---------------------------------------------------------------- menu
  // Right clicking the character opens a small menu. It is the most direct
  // way to turn the model off without hunting for the tray icon.
  let menuOpen = false;

  function closeMenu(): void {
    if (!menuOpen) return;
    menuOpen = false;
    menuEl.hidden = true;
  }

  function openMenu(x: number, y: number): void {
    menuOpen = true;
    menuEl.hidden = false;
    // Keep the menu inside of the window.
    const maxX = Math.max(4, window.innerWidth - menuEl.offsetWidth - 4);
    const maxY = Math.max(4, window.innerHeight - menuEl.offsetHeight - 4);
    menuEl.style.left = `${Math.round(Math.min(Math.max(4, x), maxX))}px`;
    menuEl.style.top = `${Math.round(Math.min(Math.max(4, y), maxY))}px`;
  }

  menuHide.addEventListener("click", async () => {
    closeMenu();
    log("character hidden from the menu");
    await api.setWindowVisible(false);
  });

  menuChat.addEventListener("click", () => {
    closeMenu();
    toggleChat(true);
  });

  menuQuit.addEventListener("click", () => {
    closeMenu();
    void api.quitApp();
  });

  canvas.addEventListener("contextmenu", (event) => {
    // The webview would show its own menu, which is not what we want here.
    event.preventDefault();
    openMenu(event.clientX, event.clientY);
  });

  // A click somewhere else closes the menu again.
  window.addEventListener("pointerdown", (event) => {
    if (!menuOpen) return;
    const target = event.target as Node | null;
    if (target && menuEl.contains(target)) return;
    closeMenu();
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
    } else if (lower.some((a) => a.includes("body"))) {
      character.motion("TapBody", 1, 3);
      character.expression("F03");
      const line = pick(BODY_REACTIONS);
      chat.say(line);
      showBubble(line);
    } else {
      const line = pick(IDLE_REACTIONS);
      chat.say(line);
      showBubble(line);
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
      layoutBubble();
      layoutChat();
      void api.setConfig(config);
    },
    { passive: false },
  );

  // ---------------------------------------------------------------- hit testing
  // The window is never clipped. WebView2 renders the character with a full
  // 8-bit alpha channel and DWM blends it per pixel with the desktop, so the
  // soft anti-aliased edge of the artwork is preserved. Only mouse handling is
  // gated: when the cursor is not over an opaque model pixel or a UI panel the
  // window becomes WS_EX_TRANSPARENT, so the click falls through to whatever
  // is below it. Hit-testing uses the same alpha mask the old window region
  // was built from, but it no longer affects what is drawn.
  let passthrough = false;
  let interactive = false;

  function uiRects(): Rect[] {
    const rects: Rect[] = [];
    for (const el of [chatEl, bubbleEl, toastEl, menuEl]) {
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

  function isOverUi(x: number, y: number): boolean {
    return uiRects().some(
      (r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h,
    );
  }

  async function setPassthrough(next: boolean): Promise<void> {
    if (next === passthrough) return;
    passthrough = next;
    try {
      await api.setPassthrough(next);
    } catch (error) {
      console.error("could not change mouse passthrough", error);
    }
  }

  // ---------------------------------------------------------------- polling
  let lastCursor = { x: 0, y: 0 };
  let characterVisible = true;
  let lastVisibleCheck = 0;
  let lastOverlayLayout = 0;

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
        // The button is held, so the window must stay interactive.
        await setPassthrough(false);
        await api.setWindowPosition(
          windowOrigin.x + (cursor.x - dragOrigin.x),
          windowOrigin.y + (cursor.y - dragOrigin.y),
        );
        return;
      }

      const sx = (cursor.x - bounds.x) / bounds.scaleFactor;
      const sy = (cursor.y - bounds.y) / bounds.scaleFactor;

      character.focus(sx, sy);

      if (!pointerDown) {
        const active = !config.clickThrough || isOverUi(sx, sy) || character.isOpaqueAt(sx, sy);
        interactive = active;
        await setPassthrough(!active);
      }

      // A hidden character does not have to be animated, that saves a lot of
      // cpu while she is turned off.
      const now = performance.now();

      // The alpha mask (and therefore the head position) refreshes a few times
      // per second. Keep the dialogue surfaces glued to it without touching the
      // DOM on every single poll.
      if (now - lastOverlayLayout > 180) {
        lastOverlayLayout = now;
        layoutBubble();
        layoutChat();
      }

      if (now - lastVisibleCheck > 1000) {
        lastVisibleCheck = now;
        const visible = await api.windowVisible();
        if (visible !== characterVisible) {
          characterVisible = visible;
          log(`character ${visible ? "shown" : "hidden"}`);
          if (visible) {
            app.ticker.start();
          } else {
            app.ticker.stop();
            await setPassthrough(true);
          }
        }
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
      `heartbeat: fps=${app.ticker.FPS.toFixed(0)} opaque=${character.opaquePixels}/${character.maskPixels} (${ratio.toFixed(1)}%) mouse=${interactive ? "interactive" : "through"} model=${model ? `${model.scale.x.toFixed(3)}@${model.position.x.toFixed(0)},${model.position.y.toFixed(0)}` : "none"}`,
    );
  }, 5000);

  log("ready");
}
