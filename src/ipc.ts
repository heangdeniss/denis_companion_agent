import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  BackendInfo,
  ChatMsg,
  CursorPos,
  ModelEntry,
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
  windowBounds: () => invoke<WindowBounds>("window_bounds"),
  setWindowPosition: (x: number, y: number) => invoke<void>("set_window_position", { x, y }),
  setAlwaysOnTop: (on: boolean) => invoke<void>("set_always_on_top", { on }),
  toggleWindow: () => invoke<void>("toggle_window"),
  /** Shows or hides the character, the app keeps running in the tray. */
  setWindowVisible: (visible: boolean) => invoke<void>("set_window_visible", { visible }),
  windowVisible: () => invoke<boolean>("window_visible"),
  quitApp: () => invoke<void>("quit_app"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  detectBackend: () => invoke<BackendInfo>("detect_backend"),
  chat: (messages: ChatMsg[]) => invoke<void>("chat", { messages }),
};
