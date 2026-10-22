import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  BackendInfo,
  ChatMsg,
  CursorPos,
  ModelEntry,
  Rect,
  WindowBounds,
} from "./types";

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  setConfig: (config: AppConfig) => invoke<void>("set_config", { config }),
  modelsDir: () => invoke<string>("models_dir"),
  listModels: () => invoke<ModelEntry[]>("list_models"),
  modelBaseUrl: () => invoke<string>("model_base_url"),
  cursorPos: () => invoke<CursorPos>("cursor_pos"),
  setPassthrough: (ignore: boolean) => invoke<void>("set_passthrough", { ignore }),
  setClickRegion: (rects: Rect[]) =>
    invoke<void>("set_click_region", {
      rects: rects.map((r) => [r.x, r.y, r.w, r.h]),
    }),
  windowBounds: () => invoke<WindowBounds>("window_bounds"),
  setWindowPosition: (x: number, y: number) => invoke<void>("set_window_position", { x, y }),
  setAlwaysOnTop: (on: boolean) => invoke<void>("set_always_on_top", { on }),
  toggleWindow: () => invoke<void>("toggle_window"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  detectBackend: () => invoke<BackendInfo>("detect_backend"),
  chat: (messages: ChatMsg[]) => invoke<void>("chat", { messages }),
};
