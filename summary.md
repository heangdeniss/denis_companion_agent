# Ei Waifu - Project Summary

## What It Is
A personal desktop companion app (Tauri v2 + PixiJS v7 + Live2D Cubism 4) that renders a Live2D
character on your Windows desktop with per-pixel click-through, drag-to-move, a chat panel powered
by a local LLM and a wardrobe of swappable outfits.

## Current State (verified facts)
- **Build works**: `npm run build` (Vite) succeeds; the release exe must be built with
  `npm run tauri build` (or `npx @tauri-apps/cli build`). Do **not** use a bare
  `cargo build --release`: without the `custom-protocol` feature the exe loads
  `http://localhost:1420` and shows a blank window.
- **Release exe**: `E:\Ei Model\src-tauri\target\release\ei-waifu.exe`
- **Installers**: `src-tauri\target\release\bundle\nsis\...` and `...\bundle\msi\...`
- **Character assets**: `E:\Ei Model\assets\characters\aria\base` (moc3, 2 atlases, 8 expressions,
  26 motions) plus `E:\Ei Model\assets\characters\aria\outfits\<id>\outfit.json`
- **The assets are seeded** into `%APPDATA%\com.ei.waifu\assets` for release builds, the models
  folder `%APPDATA%\com.ei.waifu\models` stays for user models.
- **Log**: `%APPDATA%\com.ei.waifu\ei-waifu.log` (heartbeat, hit test, animation counters)

## Architecture
| Layer | File | Purpose |
|---|---|---|
| Rust entry | `src-tauri/src/lib.rs` | Single-instance guard, tray menu, config, asset roots, `list_models`, `list_outfits`, `assets_dir` |
| Win32 FFI | `src-tauri/src/win.rs` | `SetWindowRgn` for per-pixel click-through; named mutex, show/hide/close |
| Model server | `src-tauri/src/http.rs` | Loopback HTTP server so Live2D can resolve relative moc3/textures |
| LLM | `src-tauri/src/llm.rs` | Ollama (preferred) / LM Studio fallback, streaming |
| Render | `src/character.ts` | Live2D model, scale fit, alpha mask, animation state machine, outfit swap |
| Outfits | `src/outfits.ts` | The preset list (Default / Sexy / Modern / Vintage) and the menu groups |
| Orchestration | `src/app.ts` | Pixi app, pointer/drag, chat wiring, context menu + outfit panel |
| IPC | `src/ipc.ts` | Wrappers for the tauri commands |
| Styling | `src/styles.css` | Transparent body, chat/bubble/toast/menu/outfit panels |

## Asset layout
```
assets/characters/<character>/
├── base/            the Live2D model (moc3, atlases, expressions, motions)
└── outfits/
    ├── default/     outfit.json (+ the replacement atlases)
    ├── bunny/
    └── ...
```
`models/<name>/<file>.model3.json` still works as a plain model folder. The loopback server is
rooted at the folder that holds `models/` and `assets/`, so every asset is reachable over http.

## Key Technical Decisions
1. **Per-pixel click-through** = `SetWindowRgn` on the top-level window, region built from the
   Live2D alpha mask silhouette + UI rects.
2. **Mask capture** renders the stage scaled down into a `RenderTexture`, then
   `renderer.extract.pixels()` reads the alpha channel.
3. `Live2DModel.from(url, { ticker, motionPreload: ALL })` - every motion and expression is loaded
   up front, a lazy load would pop into place and look like a flicker.
4. **The animation does not depend on the text stream.** The mouth is an own clock
   (`startTalking`/`stopTalking`), the text only fills the bubble. A reaction (motion + expression)
   is rate limited (`REACTION_COOLDOWN`), so a click can never restart a motion that is still
   playing - that was the reason she was jumping between the poses.
5. **An outfit is a second set of texture atlases with the same UV layout.** Aria is one mesh
   (`base/*.moc3`), the clothes are painted into the atlases. An outfit folder holds the atlases
   under the same file names and the same pixel size as the base ones. The mesh, the physics, the
   expressions and the motions are never touched, so switching an outfit can neither move her head
   nor break the alignment of the overlay.
6. **The swap replaces `model.textures[i]` in place.** The renderer binds the atlases by their
   index, so the pixels change while everything else stays. The model is not reloaded (that would
   show a blank frame) and the alpha mask is refreshed right after the swap, so the hit map never
   uses a stale silhouette.
7. **The backend validates the artwork**: the pixel size of every outfit atlas is read from the
   png header and compared with the base atlas. An outfit that does not fit is reported as
   unavailable and the app falls back to the default outfit.
8. **The selection is persisted** in the app config (`selectedOutfit`), the same place as every
   other setting.
9. **The outfit list is read again every time the panel opens**, so artwork that is dropped into
   the assets folder is picked up without restarting the app. The list is only rebuilt when
   something really changed, the panel does not flicker.

## Outfits
- The context menu has *Change Outfit*. It opens a panel next to the menu with the outfits,
  grouped by category:
  - Default: *Default (Office Suit)*
  - Sexy: *Bunny Suit*, *Off-Shoulder Knit*, *Qipao*
  - Modern: *Streetwear Hoodie*, *Smart Casual*
  - Vintage: *Gothic Maid*, *50s Retro Swing*
- An outfit without artwork is listed but marked as missing. Picking it says why and keeps the
  default outfit.
- **The artwork is still missing.** The atlases have to be painted on the same UV layout
  (`assets/README.md` describes the contract). Until then only *Default (Office Suit)* can be worn.

## Verified (release build, 2026-10-22)
- `models found: 1 [{"name":"aria","file":"assets/characters/aria/base/Haru.model3.json"}]`, the
  model loads and the mask is built.
- `outfits: default, bunny (missing), knit (missing), ...` - the backend finds the folders and
  reports the missing artwork.
- The panel opens next to the menu, the groups are *Default / Sexy / Modern / Vintage*, the
  current outfit is marked, the ones without artwork are dimmed and their tooltip says why.
  When there is no room on the right the panel flips to the left of the menu.
- Picking an outfit without artwork: `outfit bunny is not available: the texture atlases are
  missing` -> the toast says it and the default outfit stays on.
- The swap itself was proven with a temporary copy of the base atlases in
  `outfits/bunny`: `outfit: bunny (2 atlases)`, the model position did not change
  (`model=0.050@52,287` before and after) and the mask was refreshed right after the swap.
- The panel reads the assets again every time it opens, so artwork that is dropped in while the
  app runs shows up without a restart: the log changed to `outfits: default, bunny (missing),
  knit, ...` and the item lost its *missing* mark.
- The selection survives a restart: the app boots with `outfit: bunny`, and falls back to
  `default` when the artwork is gone again.
- The animation stays still while she answers: during a streamed reply the log shows
  `animation: talking` -> `animation: idle` once, `exprChanges=0` and `starts` only grows with
  the idle motion.

## Useful Commands
```powershell
npm run build                    # vite build
npm run tauri dev                # dev run
npm run tauri build              # release exe + installers (use this, not cargo build)
Get-Content "$env:APPDATA\com.ei.waifu\ei-waifu.log" -Tail 30   # diagnostics
```

## Turning the model off
There are now three ways to get rid of the character:

1. **Right-click the character** -> *Hide character* (window hides, app keeps running in the tray),
   *Change Outfit*, *Open chat*, *Reset size* or *Quit Ei Waifu* (full exit).
2. **Tray icon** -> *Show / hide character* or *Quit Ei Waifu*.
3. **Scripts** in the project folder:
   - `Hide Ei Waifu.cmd` -> sends `--hide` to the running copy (turns the model off, keeps it in the tray)
   - `Start Ei Waifu.cmd` -> sends `--show` to the running copy, starts it if it is not running
   - `Stop Ei Waifu.cmd` -> sends `--quit`, then kills `ei-waifu.exe` as a safety net

Only one instance can run at a time (named mutex `Local\EiWaifuSingleInstance`); a second start
forwards its CLI flag to the running instance instead of spawning another model.

## Launch Helpers
- `E:\Ei Model\Start Ei Waifu.cmd` - starts the release exe, or shows the already running copy
- `E:\Ei Model\Hide Ei Waifu.cmd` - turns the model off without quitting
- `E:\Ei Model\Stop Ei Waifu.cmd` - quits the app completely
- To autostart: Win+R -> `shell:startup` -> drop a shortcut to `Start Ei Waifu.cmd`

## Caveat
I can't visually inspect the running window, so claims about "the clipping is fixed" or "the edges
are smooth" based only on log output are inferences, not verified observations. The log confirms
the model renders and the region updates, but not that the right edge is clean.
