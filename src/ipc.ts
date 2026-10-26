import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  BackendInfo,
  ChatMsg,
  CursorPos,
  HitStats,
  ModelEntry,
  OutfitEntry,
  Rect,
  WindowBounds,
} from "./types";

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  setConfig: (config: AppConfig) => invoke<void>("set_config", { config }),
  modelsDir: () => invoke<string>("models_dir"),
  assetsDir: () => invoke<string>("assets_dir"),
  listModels: () => invoke<ModelEntry[]>("list_models"),
  /** The outfits of the character that owns the given model file. */
  listOutfits: (model: string) => invoke<OutfitEntry[]>("list_outfits", { model }),
  modelBaseUrl: () => invoke<string>("model_base_url"),
  cursorPos: () => invoke<CursorPos>("cursor_pos"),
  setPassthrough: (ignore: boolean) => invoke<void>("set_passthrough", { ignore }),
  /** True when the native per pixel hit test can be used. */
  hitTestAvailable: () => invoke<boolean>("hit_test_available"),
  /** The packed silhouette of the character, one bit per cell. */
  setHitMap: (
    bits: number[],
    cols: number,
    rows: number,
    cell: number,
    scale: number,
  ) => invoke<void>("set_hit_map", { bits, cols, rows, cell, scale }),
  /** The parts of the user interface that take the mouse. */
  setUiRects: (rects: Rect[]) => invoke<void>("set_ui_rects", { rects }),
  /** While forced the whole window reacts to the mouse. */
  setHitForce: (force: boolean) => invoke<void>("set_hit_force", { force }),
  /** Turns the click-through on or off. */
  setHitEnabled: (enabled: boolean) => invoke<void>("set_hit_enabled", { enabled }),
  /** A snapshot of the native hit test, used while debugging. */
  hitTestStats: () => invoke<HitStats>("hit_test_stats"),
  windowBounds: () => invoke<WindowBounds>("window_bounds"),
  setWindowPosition: (x: number, y: number) => invoke<void>("set_window_position", { x, y }),
  /** Resizes the overlay. `keepBottom` grows it upwards instead of sideways. */
  setWindowSize: (width: number, height: number, keepBottom: boolean) =>
    invoke<void>("set_window_size", { width, height, keepBottom }),
  setAlwaysOnTop: (on: boolean) => invoke<void>("set_always_on_top", { on }),
  toggleWindow: () => invoke<void>("toggle_window"),
  /** Shows or hides the character, the app keeps running in the tray. */
  setWindowVisible: (visible: boolean) => invoke<void>("set_window_visible", { visible }),
  windowVisible: () => invoke<boolean>("window_visible"),
  quitApp: () => invoke<void>("quit_app"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  detectBackend: () => invoke<BackendInfo>("detect_backend"),
  chat: (messages: ChatMsg[]) => invoke<void>("chat", { messages }),
  listLocalModels: () => invoke<string[]>("list_local_models").catch(() => [] as string[]),
  speakLocal: (text: string) => invoke<string>("speak_local", { text }).catch(() => ""),
  ttsAvailable: () => invoke<boolean>("tts_available").catch(() => false),
};
