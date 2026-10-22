# Ei Waifu - Project Summary

## What It Is
A personal desktop companion app (Tauri v2 + PixiJS v7 + Live2D Cubism 4) that renders a Live2D character on your Windows desktop with per-pixel click-through, drag-to-move, and a chat panel powered by a local LLM.

## Current State (verified facts)
- **Build works**: `npm run build` (Vite) succeeds; the release exe must be built with `npm run tauri build`.
  Do **not** use a bare `cargo build --release`: without the `custom-protocol` feature the exe loads
  `http://localhost:1420` and shows a blank window.
- **Release exe exists**: `E:\Ei Model\src-tauri\target\release\ei-waifu.exe`
- **Installers built**: `src-tauri\target\release\bundle\nsis\Ei Waifu_0.1.0_x64-setup.exe` and `...\bundle\msi\Ei Waifu_0.1.0_x64_en-US.msi`
- **Model present**: `E:\Ei Model\models\haru\Haru.model3.json` (+ moc3, textures, motions, expressions)
- **Models copied** to `%APPDATA%\com.ei.waifu\models\haru` for release builds
- **Log confirms working render**: `model ready: 2400x4500 scale=0.157`, `mask ready: 828x1296 opaque=58621`, heartbeats at ~145 fps, region rect count ~320-340
- **Dev app was running** via `npm run tauri dev`

## Architecture
| Layer | File | Purpose |
|---|---|---|
| Rust entry | `src-tauri/src/lib.rs` | Single-instance guard + CLI flags, tray menu, commands: `set_click_region`, `cursor_pos`, `window_bounds`, `set_window_position`, `set_window_visible`, `window_visible`, `quit_app`, `chat`, `list_models` |
| Win32 FFI | `src-tauri/src/win.rs` | `SetWindowRgn` with `CombineRgn` (RGN_OR=2) for per-pixel click-through; named mutex, show/hide/close window |
| Model server | `src-tauri/src/http.rs` | Loopback HTTP server so Live2D can resolve relative moc3/textures |
| LLM | `src-tauri/src/llm.rs` | Ollama (preferred) / LM Studio fallback, streaming |
| Render | `src/character.ts` | Live2D model, scale fit, alpha mask capture, `regionRects()` silhouette |
| Orchestration | `src/app.ts` | Pixi app, region throttling, pointer/drag, chat wiring |
| IPC | `src/ipc.ts` | `setClickRegion` wrapper |
| Styling | `src/styles.css` | Transparent body, chat/bubble/toast panels |

## Key Technical Decisions
1. **Per-pixel click-through** = `SetWindowRgn` on the top-level window, region built from Live2D alpha mask silhouette + UI rects. (Replaced `WS_EX_TRANSPARENT`.)
2. **Region updates throttled** (~140ms) and skipped while pointer is down, `SetWindowRgn` called with `bRedraw=false` to avoid DWM stutter with WebView2.
3. **Mask capture** renders the stage scaled down into a `RenderTexture` (fixes the earlier top-left-crop bug), then `renderer.extract.pixels()` reads the alpha channel.
4. **Mask size** = `viewWidth * 1.8` (currently 828x1296 for a 460x720 window) — expanded specifically to stop right-side clipping.
5. **Alpha threshold** = 12, rect dilation = ±1 css px.
6. `Live2DModel.from(url, { ticker: app.ticker })` is required for the plugin to animate.
7. `app.screen.width/height` is the correct viewport source (not `stage` bounds).

## Open Issues
- Right-side clipping / jagged edges were reported but **never visually confirmed fixed** — the app was verified only via log numbers, never by looking at it.
- Region is inherently binary (axis-aligned rects), so hit-test edges are always quantized. True per-pixel hit testing is not possible with `SetWindowRgn`.
- Ollama/LM Studio were offline in the dev environment (`backend detected ... error: No local inference server found`).

## Useful Commands
```powershell
npm run build                    # vite build
npm run tauri dev                # dev run
npm run tauri build              # release exe + installers (use this, not cargo build)
Get-Content "$env:APPDATA\com.ei.waifu\ei-waifu.log" -Tail 30   # diagnostics
```

## Turning the model off
There are now three ways to get rid of the character:

1. **Right-click the character** → *Hide character* (window hides, app keeps running in the tray),
   *Toggle chat*, or *Quit Ei Waifu* (full exit).
2. **Tray icon** → *Show / hide character* or *Quit Ei Waifu*.
3. **Scripts** in the project folder:
   - `Hide Ei Waifu.cmd` → sends `--hide` to the running copy (turns the model off, keeps it in the tray)
   - `Start Ei Waifu.cmd` → sends `--show` to the running copy, starts it if it is not running
   - `Stop Ei Waifu.cmd` → sends `--quit`, then kills `ei-waifu.exe` as a safety net

Only one instance can run at a time (named mutex `Local\EiWaifuSingleInstance`); a second start
forwards its CLI flag to the running instance instead of spawning another model.

## Launch Helpers
- `E:\Ei Model\Start Ei Waifu.cmd` — starts the release exe, or shows the already running copy
- `E:\Ei Model\Hide Ei Waifu.cmd` — turns the model off without quitting
- `E:\Ei Model\Stop Ei Waifu.cmd` — quits the app completely
- To autostart: Win+R → `shell:startup` → drop a shortcut to `Start Ei Waifu.cmd`

## Caveat
I can't visually inspect the running window, so claims about "clipping fixed" or "edges smooth" based only on log output are inferences, not verified observations. The log confirms the model renders and the region updates, but not that the right edge is clean.
