import { listen } from "@tauri-apps/api/event";
import { Application, UPDATE_PRIORITY } from "pixi.js";
import { Character } from "./character";
import { Chat, extractEmotionTag } from "./chat";
import { Interaction } from "./interaction";
import { api } from "./ipc";
import { log } from "./logger";
import { groupOutfits, mergeOutfits, DEFAULT_OUTFIT } from "./outfits";
import type { AppConfig, Rect } from "./types";
import { Voice } from "./voice";
import { tts, isMuted } from "./tts";
import { addMemory, initMemory, hasMemory, detectUserName, detectFacts, rememberFact, recallUserName, getMemory, getTimeGreeting, checkBattery, flushMemory } from "./memory";

const POLL_INTERVAL = 40;
/** How often the silhouette is handed over to the native hit test (ms). */
const HIT_MAP_INTERVAL = 120;
/** Room that is kept free above the character for the speech bubble. */
const BUBBLE_SPACE = 56;
/** Smallest size the overlay may be dragged to. */
const MIN_WIDTH = 220;
const MIN_HEIGHT = 200;

const GREETINGS = [
  "Hi~ You're finally here.",
  "Hey! What are we doing today?",
  "I was waiting for you (^-^)",
  "You look busy... want a small break?",
  "Good to see you again!",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export async function bootstrap(): Promise<void> {
  const config: AppConfig = await api.getConfig();
  log("boot: config loaded", config);

  // The memory has to be ready before the Chat is constructed, because the
  // saved conversation is seeded into her history there.
  await initMemory();

  // A name from an earlier session is recovered from the memory, so the first
  // greeting already uses it even if the config was never updated back then.
  if (!config.userName || config.userName === "you") {
    const remembered = recallUserName();
    if (remembered) {
      config.userName = remembered;
      void api.setConfig(config);
    }
  }

  const stageEl = document.getElementById("stage") as HTMLDivElement;
  const bubbleEl = document.getElementById("bubble") as HTMLDivElement;
  const bubbleText = document.getElementById("bubble-text") as HTMLSpanElement;
  const chatEl = document.getElementById("chat") as HTMLElement;
  const chatLog = document.getElementById("chat-log") as HTMLDivElement;
  const chatStatus = document.getElementById("chat-status") as HTMLDivElement;
  const chatForm = document.getElementById("chat-form") as HTMLFormElement;
  const chatInput = document.getElementById("chat-input") as HTMLInputElement;
  const chatName = document.getElementById("chat-name") as HTMLSpanElement;
  const chatClose = document.getElementById("chat-close") as HTMLButtonElement;
  const toastEl = document.getElementById("toast") as HTMLDivElement;
  const menuEl = document.getElementById("menu") as HTMLMenuElement;
  const menuHide = document.getElementById("menu-hide") as HTMLButtonElement;
  const menuChat = document.getElementById("menu-chat") as HTMLButtonElement;
  const menuOutfit = document.getElementById("menu-outfit") as HTMLButtonElement;
  const menuSize = document.getElementById("menu-size") as HTMLButtonElement;
  const menuQuit = document.getElementById("menu-quit") as HTMLButtonElement;
  const menuVoice = document.createElement("button");
  menuVoice.type = "button";
  menuVoice.className = "menu-item";
  menuVoice.textContent = isMuted() ? "Unmute Voice" : "Mute Voice";
  menuEl.insertBefore(menuVoice, menuQuit);
  const outfitPanel = document.getElementById("outfit-panel") as HTMLElement;
  const outfitList = document.getElementById("outfit-list") as HTMLDivElement;
  const gripEl = document.getElementById("resize-grip") as HTMLDivElement;

  chatName.textContent = config.personaName || "Companion";

  // The timers have to exist before the first toast or bubble is shown. The
  // error paths below run before the ui section, and a `let` that is read
  // before its declaration throws a temporal dead zone error.
  let bubbleTimer: number | undefined;
  let toastTimer: number | undefined;

  // The native hit test lets the mouse through every empty pixel of the
  // overlay. When it is not available the whole window is made click-through
  // instead, which is the fallback for other platforms.
  const nativeHitTest = await api.hitTestAvailable();
  log(`native hit test: ${nativeHitTest}`);

  // ---------------------------------------------------------------- pixi app
  // Render at least 2x the device pixel ratio. The model is painted at a
  // fraction of the window size, so supersampling keeps her silhouette and
  // the soft edges of the artwork smooth instead of stair-stepping.
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

  const character = new Character(app);
  // A small hook for the asset tooling and the dev tools of the webview: it
  // makes the live model reachable, which is how the UV layout of the texture
  // atlases is read while an outfit is painted.
  (window as unknown as { ei: unknown }).ei = { app, character, tts };

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

  // ---------------------------------------------------------------- outfits
  // The list of outfits is fixed, the backend tells which of them have their
  // artwork in the assets folder.
  let outfitOptions = mergeOutfits(
    await api.listOutfits(entry.file).catch((error) => {
      log(`the outfits could not be read: ${error}`);
      return [];
    }),
  );
  log(
    `outfits: ${outfitOptions
      .map(
        (option) =>
          `${option.id}${option.available ? "" : " (broken)"}${
            option.hasArtwork ? "" : " (no artwork)"
          }`,
      )
      .join(", ")}`,
  );
  // The mouth is animated on its own clock, the text stream never touches it.
  app.ticker.add(() => character.tick(app.ticker.deltaMS));
  // The mask is refreshed after the frame was drawn: the extra render then
  // shows exactly what is on the screen and cannot interrupt the frame.
  app.ticker.add(() => character.updateMask(), undefined, UPDATE_PRIORITY.UTILITY);
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
    bubbleEl.style.top = `${Math.round(top)}px`;
    bubbleEl.style.transform = "translateX(-50%)";
  }

  function layoutChat(): void {
    if (chatEl.hidden) return;
    const anchor = character.headAnchor();
    const gap = 12;
    // Keep the whole panel inside of the window while its bottom edge rests
    // just above her head. A panel that was made smaller by hand keeps its
    // size, only a panel that does not fit is cut off.
    const available = Math.max(80, Math.round(anchor.y - gap - 6));
    if (chatEl.offsetHeight > available) {
      chatEl.style.maxHeight = `${available}px`;
    } else {
      chatEl.style.maxHeight = "";
    }
    const width = chatEl.offsetWidth;
    const height = chatEl.offsetHeight;
    const top = Math.max(6 + height, Math.round(anchor.y - gap));
    const minX = 8 + width / 2;
    const maxX = window.innerWidth - 8 - width / 2;
    const x = Math.min(Math.max(anchor.x, minX), Math.max(minX, maxX));
    chatEl.style.left = `${Math.round(x)}px`;
    chatEl.style.top = `${Math.round(top)}px`;
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
      if (nativeHitTest) {
        await api.setHitEnabled(false);
      } else {
        await api.setPassthrough(true);
      }
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

  /** The small line under the name tells how the connection looks. */
  function setChatStatus(text: string, isError = false): void {
    chatStatus.textContent = text;
    chatStatus.classList.toggle("error", isError);
  }

  // ---------------------------------------------------------------- backend
  // Ollama is often still starting when the overlay appears, and it can be
  // restarted at any time. A single probe at boot would leave the chat on
  // "offline" until the app itself is restarted, so the server is re-probed
  // whenever the chat opens and then on a timer.
  let backendOnline = false;
  let backendProbe: Promise<boolean> | null = null;

  async function refreshBackend(announce = false): Promise<boolean> {
    if (backendProbe) return backendProbe;
    backendProbe = (async () => {
      try {
        const backend = await api.detectBackend();
        const online = !backend.error && !!backend.provider;
        if (online !== backendOnline) {
          log(`backend ${online ? "online" : "offline"}`, backend);
        }
        backendOnline = online;

        if (online) {
          setChatStatus(`connected · ${backend.provider} · ${backend.activeModel}`);
        } else {
          const reason = backend.error || "no local inference server";
          setChatStatus(`offline · ${reason}`, true);
          if (announce) showToast(reason);
        }
        return online;
      } catch (error) {
        backendOnline = false;
        const reason = String(error);
        log("backend probe failed", reason);
        setChatStatus(`offline · ${reason}`, true);
        if (announce) showToast(reason);
        return false;
      } finally {
        backendProbe = null;
      }
    })();
    return backendProbe;
  }

  /**
   * While she is offline the server is probed every few seconds, while the
   * connection is fine only twice a minute - enough to notice a restart
   * without polling the loopback port for no reason.
   */
  function watchBackend(): void {
    window.setTimeout(async () => {
      await refreshBackend();
      watchBackend();
    }, backendOnline ? 30_000 : 4_000);
  }

  let chatRestored = false;
  function restoreChatLog(): void {
    if (chatRestored) return;
    chatRestored = true;
    const past = getMemory()
      .filter((entry) => entry.role !== "system" && entry.content.trim())
      .slice(-6);
    if (past.length === 0) return;
    const divider = document.createElement("div");
    divider.className = "msg system";
    divider.textContent = "~ earlier ~";
    chatLog.appendChild(divider);
    for (const entry of past) {
      const text =
        entry.role === "user" ? entry.content : extractEmotionTag(entry.content).text;
      logMessage(text, entry.role === "user" ? "user" : "her");
    }
  }

  function toggleChat(force?: boolean): void {
    const show = force ?? chatEl.hidden;
    chatEl.hidden = !show;
    log(`chat panel ${show ? "opened" : "closed"}`);
    if (show) {
      bubbleEl.hidden = true;
      restoreChatLog();
      layoutChat();
      chatInput.focus();
      // The server may have come up (or died) since the last probe.
      void refreshBackend();
    }
    // The panel changes the height of the overlay.
    void applyAutoSize();
    void pushUiRects();
  }

  // ---------------------------------------------------------------- ollama auto-connect
  const chatStatusEl = document.getElementById("chat-status") as HTMLDivElement | null;
  function setChatStatusText(text: string, isError = false): void {
    if (!chatStatusEl) return;
    chatStatusEl.textContent = text;
    chatStatusEl.classList.toggle("error", isError);
    chatStatusEl.title = text;
  }

  async function waitForOllama(maxMs = 10000): Promise<{
    online: boolean;
    model: string;
  }> {
    const start = Date.now();
    let delay = 500;
    while (Date.now() - start < maxMs) {
      try {
        const res = await fetch("http://127.0.0.1:11434/api/version", {
          method: "GET",
          cache: "no-store",
        });
        if (res.ok) {
          // try to get model
          try {
            const r2 = await fetch("http://127.0.0.1:11434/api/tags", {
              cache: "no-store",
            });
            if (r2.ok) {
              const j = await r2.json();
              const models = Array.isArray(j?.models) ? j.models : [];
              const name =
                models[0]?.name ||
                models[0]?.model ||
                config.llmModel ||
                "ollama";
              return { online: true, model: name };
            }
          } catch {}
          return { online: true, model: config.llmModel || "ollama" };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.4, 2000);
    }
    return { online: false, model: "" };
  }

  setChatStatusText("Starting LLM server...");
  void (async () => {
    const res = await waitForOllama(10000);
    if (res.online) {
      setChatStatusText(`Connected to ollama (${res.model})`);
    } else {
      setChatStatusText("Failed to connect to LLM server. Click to retry.", true);
      if (chatStatusEl) {
        chatStatusEl.style.cursor = "pointer";
        chatStatusEl.onclick = () => {
          setChatStatusText("Starting LLM server...");
          chatStatusEl.onclick = null;
          chatStatusEl.style.cursor = "";
          void (async () => {
            const r = await waitForOllama(10000);
            if (r.online) {
              setChatStatusText(`Connected to ollama (${r.model})`);
            } else {
              setChatStatusText(
                "Failed to connect to LLM server. Click to retry.",
                true,
              );
              if (chatStatusEl) {
                chatStatusEl.style.cursor = "pointer";
                chatStatusEl.onclick = () => {
                  setChatStatusText("Starting LLM server...");
                  chatStatusEl.onclick = null;
                  chatStatusEl.style.cursor = "";
                  void (async () => {
                    const rr = await waitForOllama(10000);
                    if (rr.online)
                      setChatStatusText(`Connected to ollama (${rr.model})`);
                    else {
                      setChatStatusText(
                        "Failed to connect to LLM server. Click to retry.",
                        true,
                      );
                      chatStatusEl.onclick = null;
                      chatStatusEl.style.cursor = "";
                    }
                  })();
                };
              }
            }
          })();
        };
      }
    }
  })();

  // ---------------------------------------------------------------- chat
  const chat = new Chat(config, {
    // The tokens only fill the bubble. They must not touch the animation:
    // the mouth moves on its own clock, so she keeps a steady pose while she
    // is talking.
    onDelta: (text) => {
      character.startTalking();
      character.startTextSpeaking();
      const { text: display } = extractEmotionTag(text);
      // The tag alone is not a line: the bubble waits for the first words.
      if (display.trim()) {
        showBubble(display, Math.max(4, config.bubbleSeconds));
      }
    },
    onDone: (full) => {
      character.stopTalking();
      character.stopTextSpeaking();
      if (full.trim()) {
        const { tag, text: display } = extractEmotionTag(full.trim());
        if (tag) {
          character.applyEmotionExpression(tag);
        }
        logMessage(display, "her");
        showBubble(display, Math.max(4, config.bubbleSeconds));
        try {
          addMemory({ role: "assistant", content: display });
          void flushMemory();
        } catch {}
        // Speak with TTS and lip-sync
        tts.speak(full, {
          onStart: () => {
            character.startVoiceTalking();
          },
          onEnd: () => {
            character.stopVoiceTalking();
            character.setMouthOpen(0);
          },
          onMouth: (v) => {
            character.setMouthOpen(v);
          },
        });
      }
      void api.setConfig(config);
    },
    onError: (message) => {
      character.stopTalking();
      character.stopTextSpeaking();
      character.clearEmotion();
      // The retry loop goes back to the fast cadence so a restarted server is
      // picked up on its own.
      backendOnline = false;
      logMessage(`[error] ${message}`, "system");
      setChatStatus(`offline · ${message}`, true);
      showToast(message);
    },
  });

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = chatInput.value;
    if (!text.trim()) return;
    chatInput.value = "";
    logMessage(text, "user");

    // Remember the name if the user introduces themselves, so a later session
    // greets them properly even before the model is asked anything.
    const name = detectUserName(text);
    if (name && name !== config.userName) {
      config.userName = name;
      void api.setConfig(config);
      chatName.textContent = config.personaName || "Companion";
      rememberFact("name", name);
    }

    // Preferences such as a favourite colour are stored as tidy facts, so a
    // corrected answer replaces the old one instead of piling up in history.
    for (const fact of detectFacts(text)) {
      rememberFact(fact.label, fact.value);
    }

    addMemory({ role: "user", content: text });
    void flushMemory();
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
  // The bundled llama-server reports loading progress while it warms up.
  await listen<string>("chat:status", (event) => {
    setChatStatus(event.payload);
  });

  // ---------------------------------------------------------------- menu
  // Right clicking the character opens a small menu. It is the most direct
  // way to turn the model off without hunting for the tray icon.
  let menuOpen = false;

  function closeMenu(): void {
    if (!menuOpen && outfitPanel.hidden) return;
    menuOpen = false;
    menuEl.hidden = true;
    outfitPanel.hidden = true;
    void pushUiRects();
  }

  function openMenu(x: number, y: number): void {
    menuOpen = true;
    menuEl.hidden = false;
    // A fresh menu always starts without the outfit panel.
    outfitPanel.hidden = true;
    // Keep the menu inside of the window.
    const maxX = Math.max(4, window.innerWidth - menuEl.offsetWidth - 4);
    const maxY = Math.max(4, window.innerHeight - menuEl.offsetHeight - 4);
    menuEl.style.left = `${Math.round(Math.min(Math.max(4, x), maxX))}px`;
    menuEl.style.top = `${Math.round(Math.min(Math.max(4, y), maxY))}px`;
    void pushUiRects();
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

  menuOutfit.addEventListener("click", () => {
    if (outfitPanel.hidden) {
      openOutfitPanel();
    } else {
      closeMenu();
    }
  });

  menuSize.addEventListener("click", () => {
    closeMenu();
    // The size was set by hand, this gives the automatic size back.
    config.windowHeight = 0;
    void applyAutoSize();
    void api.setConfig(config);
  });

  menuVoice.addEventListener("click", () => {
    const muted = !tts.getMuted();
    tts.setMuted(muted);
    menuVoice.textContent = muted ? "Unmute Voice" : "Mute Voice";
    closeMenu();
  });

  menuQuit.addEventListener("click", () => {
    closeMenu();
    void api.quitApp();
  });

  // ---------------------------------------------------------------- outfits
  /**
   * Opens the list of outfits next to the context menu.
   *
   * The list is a panel of its own, so it can be longer than the menu and it
   * scrolls when there are many outfits.
   */
  function openOutfitPanel(): void {
    buildOutfitList();
    outfitPanel.hidden = false;

    // New artwork may have been dropped in while the app was running.
    void refreshOutfits();

    const menuBox = menuEl.getBoundingClientRect();
    const width = outfitPanel.offsetWidth;
    const height = outfitPanel.offsetHeight;

    // Next to the menu, but flipped to the left when there is no room.
    let left = menuBox.right + 6;
    if (left + width > window.innerWidth - 4) {
      left = menuBox.left - width - 6;
    }
    left = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - width - 4));

    let top = menuBox.top;
    if (top + height > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - height - 4);
    }

    outfitPanel.style.left = `${Math.round(left)}px`;
    outfitPanel.style.top = `${Math.round(top)}px`;
    void pushUiRects();
  }

  /**
   * Reads the outfits again.
   *
   * The assets folder can change while the app runs - artwork that was
   * dropped in has to show up without a restart. The list is only rebuilt
   * when something really changed, so the panel does not flicker.
   */
  async function refreshOutfits(): Promise<void> {
    const found = await api.listOutfits(entry.file).catch((error) => {
      log(`the outfits could not be read: ${error}`);
      return null;
    });
    if (!found) return;

    const options = mergeOutfits(found);
    const same =
      options.length === outfitOptions.length &&
      options.every(
        (option, index) =>
          option.id === outfitOptions[index].id &&
          option.available === outfitOptions[index].available &&
          option.hasArtwork === outfitOptions[index].hasArtwork,
      );
    if (same) return;

    outfitOptions = options;
    buildOutfitList();
    log(
      `outfits: ${options
        .map(
          (option) =>
            `${option.id}${option.available ? "" : " (broken)"}${
              option.hasArtwork ? "" : " (no artwork)"
            }`,
        )
        .join(", ")}`,
    );
  }

  /** Fills the panel with the outfits, grouped by their category. */
  function buildOutfitList(): void {
    outfitList.replaceChildren();

    for (const group of groupOutfits(outfitOptions)) {
      const header = document.createElement("div");
      header.className = "outfit-group";
      header.textContent = group.category;
      outfitList.appendChild(header);

      for (const option of group.items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "outfit-item";
        if (option.id === config.selectedOutfit) {
          button.classList.add("selected");
        }
        // An outfit without artwork is marked, it can still be picked: the
        // base clothes stay on then.
        if (!option.available || !option.hasArtwork) {
          button.classList.add("missing");
        }
        button.title = !option.available
          ? `${option.label} - ${option.problem || "the artwork is broken"}`
          : option.hasArtwork
            ? option.label
            : `${option.label} - no artwork yet, the base clothes are used`;

        const label = document.createElement("span");
        label.textContent = option.label;
        button.appendChild(label);

        const check = document.createElement("span");
        check.className = "outfit-check";
        check.textContent = option.id === config.selectedOutfit ? "✓" : "";
        button.appendChild(check);

        button.addEventListener("click", () => {
          closeMenu();
          void applyOutfit(option.id);
        });

        outfitList.appendChild(button);
      }
    }
  }

  /**
   * Puts an outfit on her and remembers it.
   *
   * An outfit without artwork wears the base clothes: that is a safe
   * fallback, not an error, and the choice is remembered so the outfit is
   * there as soon as it is painted. Only broken artwork (a wrong size, an
   * unreadable file) is reported, then the default outfit stays on.
   */
  async function applyOutfit(id: string, quiet = false): Promise<void> {
    const wanted = outfitOptions.find((option) => option.id === id);
    if (!wanted) return;
    const fallback =
      outfitOptions.find((option) => option.id === DEFAULT_OUTFIT) ?? wanted;

    let target = wanted;
    if (!wanted.available) {
      // The artwork is broken: the base clothes stay on.
      if (!quiet) {
        showToast(
          `${wanted.label}: ${wanted.problem || "the artwork is broken"} - keeping the default outfit.`,
        );
      }
      log(`outfit ${wanted.id} is not available: ${wanted.problem}`);
      target = fallback;
    }

    let ok = true;
    if (target.id === DEFAULT_OUTFIT) {
      ok = await character.setOutfit(null, base);
    } else {
      ok = await character.setOutfit(target, base);
    }
    if (!ok) {
      if (!quiet) {
        showToast(`Could not wear the ${target.label} - keeping the default outfit.`);
      }
      target = fallback;
      await character.setOutfit(null, base);
    }

    if (config.selectedOutfit !== target.id) {
      config.selectedOutfit = target.id;
      await api.setConfig(config);
    }
    log(`outfit: ${target.id}`);
  }

  // ---------------------------------------------------------------- tapping
  /**
   * The recordings live next to the model folder, in
   * `assets/characters/<name>/sounds/`. The path is derived from the model
   * file (`<character>/<variant>/<model>.json`), so another character keeps
   * its own lines.
   */
  const characterFolder = entry.file.split("/").slice(0, -2).join("/");
  const soundsRoot = `${base}${characterFolder
    .split("/")
    .map(encodeURIComponent)
    .join("/")}/sounds/`;

  const voice = new Voice();
  const interaction = new Interaction({
    character,
    voice,
    say: (line) => {
      chat.say(line);
      showBubble(line);
    },
  });
  void voice
    .attach(soundsRoot)
    .catch((error) => log(`voice: the sounds could not be loaded (${error})`));

  // The controller is reachable from the dev tools like the model itself, so
  // the body regions can be checked against a known point of the canvas.
  (window as unknown as { ei: unknown }).ei = {
    app,
    character,
    interaction,
    voice,
  };

  /**
   * A tap is answered by the body region under the cursor: head/hair,
   * face/cheeks, chest/ribbon, torso/waist or skirt/legs. Every region has
   * its own expression, motion, line and recording (see `interaction.ts`).
   */
  function handleTap(x: number, y: number): void {
    const areas = character.hitTest(x, y);
    interaction.tap(x, y, areas);
  }

  // ---------------------------------------------------------------- pointer
  // The canvas itself does not take any mouse events. Everything is decided
  // against the silhouette of the character, so an empty area of the overlay
  // belongs to the desktop underneath it.
  let pointerDown = false;
  let pointerMoved = false;
  let dragOrigin = { x: 0, y: 0 };
  let windowOrigin = { x: 0, y: 0 };
  let dragging = false;

  /** True when the point is on the character. */
  function overCharacter(x: number, y: number): boolean {
    return character.isOpaqueAt(x, y);
  }

  /** True when the point is on one of the interactive panels. */
  function overUi(x: number, y: number): boolean {
    return uiRects().some(
      (r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h,
    );
  }

  window.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0) return;
    const x = event.clientX;
    const y = event.clientY;

    // A click outside of the character closes the menu again.
    if (menuOpen && !overUi(x, y)) {
      closeMenu();
    }
    if (overUi(x, y)) return;
    if (!overCharacter(x, y)) return;

    // Shift+Left click to drag window
    if (event.shiftKey) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().startDragging();
        return;
      } catch (e) {
        log(`drag failed: ${e}`);
      }
    }

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
    log(`pointerdown at ${x.toFixed(0)},${y.toFixed(0)}`);

    // While the window is dragged the mouse belongs to the window, even when
    // it is not exactly over the character.
    await setHitForce(true);
  });

  window.addEventListener("pointermove", (event) => {
    if (!pointerDown) return;
    if (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1) {
      pointerMoved = true;
    }
  });

  window.addEventListener("pointerup", async (event) => {
    if (!pointerDown) return;
    pointerDown = false;
    dragging = false;
    await setHitForce(false);

    if (!pointerMoved) {
      handleTap(event.clientX, event.clientY);
    } else {
      // Save position after drag
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const pos = await getCurrentWindow().outerPosition();
        localStorage.setItem(
          "eiwaifu:windowPos",
          JSON.stringify({ x: pos.x, y: pos.y }),
        );
      } catch {}
    }
  });

  window.addEventListener("dblclick", (event) => {
    if (overUi(event.clientX, event.clientY)) return;
    if (!overCharacter(event.clientX, event.clientY)) return;
    toggleChat();
  });

  window.addEventListener(
    "wheel",
    (event) => {
      if (overUi(event.clientX, event.clientY)) return;
      if (!overCharacter(event.clientX, event.clientY)) return;
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.92 : 1.08;
      config.scale = clamp(config.scale * factor, 0.4, 2.5);
      character.userScale = config.scale;
      character.applyScale();
      layoutBubble();
      layoutChat();
      void applyAutoSize();
      void api.setConfig(config);
    },
    { passive: false },
  );

  window.addEventListener("contextmenu", (event) => {
    // The webview would show its own menu, which is not what we want here.
    event.preventDefault();
    if (overUi(event.clientX, event.clientY)) return;
    if (!overCharacter(event.clientX, event.clientY)) return;
    openMenu(event.clientX, event.clientY);
  });

  // ---------------------------------------------------------------- resizing
  // The grip in the corner resizes the whole overlay. The window follows the
  // mouse, the character scales with the width of it.
  let resizing = false;
  let resizeStart = { x: 0, y: 0, width: 0, height: 0 };

  gripEl.addEventListener("pointerdown", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = await api.windowBounds();
    const factor = bounds.scaleFactor || 1;
    resizeStart = {
      x: event.screenX,
      y: event.screenY,
      width: bounds.width / factor,
      height: bounds.height / factor,
    };
    resizing = true;
    await setHitForce(true);
    try {
      gripEl.setPointerCapture(event.pointerId);
    } catch {
      /* capture is optional */
    }
  });

  gripEl.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    const width = clamp(
      resizeStart.width + (event.screenX - resizeStart.x),
      MIN_WIDTH,
      900,
    );
    const height = clamp(
      resizeStart.height + (event.screenY - resizeStart.y),
      MIN_HEIGHT,
      900,
    );
    config.windowWidth = Math.round(width);
    config.windowHeight = Math.round(height);
    // The corner follows the mouse, so the top left corner stays in place.
    void api.setWindowSize(width, height, false);
  });

  const endResize = async (): Promise<void> => {
    if (!resizing) return;
    resizing = false;
    await setHitForce(false);
    void api.setConfig(config);
    log(`overlay resized to ${config.windowWidth}x${config.windowHeight}`);
  };

  gripEl.addEventListener("pointerup", () => void endResize());
  gripEl.addEventListener("pointercancel", () => void endResize());

  // The overlay is only as tall as the character and the chat need. The
  // bottom edge stays where it is, so she does not jump when the chat panel
  // is opened.
  function desiredHeight(): number {
    const sprite = character.spriteHeight();
    if (sprite <= 0) return 0;
    const chatSpace = chatEl.hidden ? 0 : chatEl.offsetHeight + 12;
    const bubbleSpace = chatEl.hidden ? BUBBLE_SPACE : 0;
    return Math.round(sprite + 8 + chatSpace + bubbleSpace);
  }

  async function applyAutoSize(): Promise<void> {
    if (config.windowHeight > 0) return; // the user picked a size
    const height = desiredHeight();
    if (height <= 0) return;
    const width = config.windowWidth || window.innerWidth;
    await api.setWindowSize(width, height, true);
  }

  // ---------------------------------------------------------------- hit test
  // The window itself decides where a click belongs to. The webview hands
  // over the silhouette of the character and the rectangles of the panels,
  // the native side answers with "mine" or "yours" for every single pixel.
  let lastHitMapAt = 0;
  let lastRectSignature = "";

  function uiRects(): Rect[] {
    const rects: Rect[] = [];
    for (const el of [chatEl, menuEl, outfitPanel, gripEl]) {
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

  async function pushUiRects(): Promise<void> {
    if (!nativeHitTest) return;
    const rects = uiRects();
    const signature = rects
      .map((r) => `${r.x},${r.y},${r.w},${r.h}`)
      .join("|");
    if (signature === lastRectSignature) return;
    lastRectSignature = signature;
    try {
      await api.setUiRects(rects);
    } catch (error) {
      console.error("could not update the ui rectangles", error);
    }
  }

  async function pushHitMap(): Promise<void> {
    if (!nativeHitTest) return;
    const map = character.hitMap(2);
    if (!map) return;
    const bounds = await api.windowBounds();
    try {
      await api.setHitMap(
        map.bits,
        map.cols,
        map.rows,
        map.cell,
        bounds.scaleFactor || 1,
      );
    } catch (error) {
      console.error("could not update the hit map", error);
    }
  }

  async function setHitForce(force: boolean): Promise<void> {
    if (!nativeHitTest) return;
    try {
      await api.setHitForce(force);
    } catch {
      /* not critical */
    }
  }

  // The old fallback: the whole window is click-through while the cursor is
  // not over the character.
  let passthrough = false;

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
        await api.setWindowPosition(
          windowOrigin.x + (cursor.x - dragOrigin.x),
          windowOrigin.y + (cursor.y - dragOrigin.y),
        );
        return;
      }

      const sx = (cursor.x - bounds.x) / bounds.scaleFactor;
      const sy = (cursor.y - bounds.y) / bounds.scaleFactor;

      // Only a cursor that is really inside the overlay is followed. Outside
      // of it she looks back to the centre, so she is not staring at the edge
      // of the screen while the user works somewhere else.
      const inside =
        sx >= 0 && sy >= 0 && sx <= window.innerWidth && sy <= window.innerHeight;
      if (inside) {
        character.lookAt(sx, sy);
      } else {
        character.lookAway();
      }

      if (!nativeHitTest && !pointerDown) {
        const active =
          !config.clickThrough || overUi(sx, sy) || overCharacter(sx, sy);
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

      if (nativeHitTest && now - lastHitMapAt > HIT_MAP_INTERVAL) {
        lastHitMapAt = now;
        await pushHitMap();
        await pushUiRects();
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
          }
        }
      }
    } catch (error) {
      console.error("poll failed", error);
    }
  }, POLL_INTERVAL);

  // ---------------------------------------------------------------- startup
  if (nativeHitTest) {
    await api.setHitEnabled(config.clickThrough);
  }

  // Restore window position if saved
  try {
    const saved = localStorage.getItem("eiwaifu:windowPos");
    if (saved) {
      const pos = JSON.parse(saved);
      if (typeof pos.x === "number" && typeof pos.y === "number") {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setPosition({ type: "Physical", x: pos.x, y: pos.y } as any);
        } catch {}
      }
    }
  } catch {}

  // She wears the outfit of the last session. An outfit whose artwork is gone
  // falls back to the default one.
  await applyOutfit(config.selectedOutfit || DEFAULT_OUTFIT, true);

  // The overlay starts with the size it had last time, or with the size the
  // character needs.
  if (config.windowWidth > 0) {
    await api.setWindowSize(config.windowWidth, config.windowHeight || 720, true);
  }
  await applyAutoSize();

  // The backend is probed now and then watched on a timer: Ollama is often
  // still starting when the window appears, and it may be restarted later.
  await refreshBackend(true);
  watchBackend();

  // Time-aware greetings. When there is saved history she says so, which is
  // the visible proof that she remembers the last session.
  try {
    const tg = getTimeGreeting();
    if (tg) {
      const name = config.userName ? `, ${config.userName}` : "";
      const line = hasMemory()
        ? `Welcome back${name}~ ${tg}`
        : `${tg}`;
      chat.say(line);
      showBubble(line);
    } else if (config.greetOnStart) {
      const line = pick(GREETINGS);
      chat.say(line);
      showBubble(line);
    }
  } catch {
    if (config.greetOnStart) {
      const line = pick(GREETINGS);
      chat.say(line);
      showBubble(line);
    }
  }

  // Battery check
  void checkBattery((msg) => {
    showToast(msg);
    chat.say(msg);
  });

  // A heartbeat makes it easy to see from the log that the render loop and
  // the model are still alive.
  window.setInterval(async () => {
    const ratio = character.maskPixels
      ? (character.opaquePixels / character.maskPixels) * 100
      : 0;
    const model = character.model;
    const stats = nativeHitTest
      ? await api.hitTestStats().catch(() => null)
      : null;
    const hit = stats
      ? `native calls=${stats.calls} client=${stats.client} through=${stats.transparent} last=${stats.lastX.toFixed(0)},${stats.lastY.toFixed(0)}=>${stats.lastResult} fresh=${stats.fresh} maps=${stats.mapUpdates}`
      : "window";
    log(
      `heartbeat: fps=${app.ticker.FPS.toFixed(0)} opaque=${character.opaquePixels}/${character.maskPixels} (${ratio.toFixed(1)}%) model=${model ? `${model.scale.x.toFixed(3)}@${model.position.x.toFixed(0)},${model.position.y.toFixed(0)}` : "none"} window=${window.innerWidth}x${window.innerHeight} hit=${hit} anim=${character.animationState()}`,
    );
  }, 5000);

  log("ready");
}
