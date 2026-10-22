export interface AppConfig {
  personaName: string;
  userName: string;
  personality: string;
  llmProvider: string;
  llmModel: string;
  ollamaBaseUrl: string;
  lmstudioBaseUrl: string;
  temperature: number;
  affinity: number;
  scale: number;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  selectedModel: string;
  bubbleSeconds: number;
  greetOnStart: boolean;
}

export interface ModelEntry {
  name: string;
  file: string;
  kind: string;
}

export interface CursorPos {
  x: number;
  y: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface BackendInfo {
  provider: string;
  baseUrl: string;
  models: string[];
  activeModel: string;
  error: string;
}

export interface ChatMsg {
  role: string;
  content: string;
}

/** A rectangle in css pixels of the webview. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
