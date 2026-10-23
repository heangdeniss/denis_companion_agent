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
  /** The outfit she is wearing, e.g. "default" or "bunny". */
  selectedOutfit: string;
  bubbleSeconds: number;
  greetOnStart: boolean;
  /** Width of the overlay in css pixels. */
  windowWidth: number;
  /** Height of the overlay in css pixels, 0 = as tall as needed. */
  windowHeight: number;
}

export interface ModelEntry {
  name: string;
  file: string;
  kind: string;
}

/**
 * One texture of an outfit.
 *
 * An outfit replaces the texture page of the model that holds the clothes,
 * the index is the position of that page in the texture list of the model.
 */
export interface OutfitTexture {
  /** The index of the atlas in the model. */
  index: number;
  /** The path of the file inside the outfit folder. */
  file: string;
}

/** One outfit of a character. */
export interface OutfitEntry {
  /** The id of the folder, e.g. "bunny". */
  id: string;
  /** The name that is shown in the menu. */
  label: string;
  /** The group the outfit is sorted into. */
  category: string;
  /** The folder of the outfit, relative to the server root. */
  path: string;
  /** The atlases this outfit replaces. */
  textures: OutfitTexture[];
  /** False when the artwork is broken, e.g. the wrong size. */
  available: boolean;
  /** Why the outfit cannot be used. */
  problem: string;
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

/** Counters of the native hit test, used while debugging. */
export interface HitStats {
  calls: number;
  client: number;
  transparent: number;
  lastX: number;
  lastY: number;
  lastResult: number;
  mapUpdates: number;
  mapBits: number;
  cols: number;
  rows: number;
  cell: number;
  scale: number;
  rects: number;
  enabled: boolean;
  force: boolean;
  fresh: boolean;
}
