import { Application, RenderTexture } from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import { log } from "./logger";
import type { Rect } from "./types";

/** How often the alpha mask is refreshed (ms). */
const MASK_INTERVAL = 95;
/** Pixels with a lower alpha are considered empty and stay click-through. */
const MASK_ALPHA_THRESHOLD = 12;

export interface CharacterEvents {
  onTap?: (hitAreas: string[]) => void;
}

/**
 * Owns the Live2D model, the pixi application and everything that makes the
 * character feel alive: eye tracking, blinking, mouth movement and the
 * per-pixel alpha mask used for click-through.
 */
export class Character {
  readonly app: Application;
  model: Live2DModel | null = null;

  /** Multiplier applied on top of the "fit the window" scale. */
  userScale = 1;

  private naturalWidth = 1;
  private naturalHeight = 1;
  private maskTexture: RenderTexture | null = null;
  private maskData: Uint8Array | Uint8ClampedArray | null = null;
  private maskWidth = 0;
  private maskHeight = 0;
  private maskScale = 1;
  private lastMaskAt = 0;
  private mouth = 0;
  private mouthTarget = 0;
  private events: CharacterEvents = {};

  /** Number of pixels covered by the character, refreshed with the mask. */
  opaquePixels = 0;

  /** Total number of pixels in the mask. */
  maskPixels = 0;

  /** Bumped every time the alpha mask was refreshed. */
  maskVersion = 0;

  private maskReported = false;

  constructor(app: Application, events: CharacterEvents = {}) {
    this.app = app;
    this.events = events;
  }

  async load(url: string): Promise<Live2DModel> {
    // the ticker is required, otherwise the plugin refuses to animate the model
    const model = await Live2DModel.from(url, { ticker: this.app.ticker });
    this.model = model;
    this.app.stage.addChild(model);
    this.naturalWidth = model.width || 1;
    this.naturalHeight = model.height || 1;
    this.applyScale();

    model.on("hit", (areas: string[]) => {
      this.events.onTap?.(areas);
    });

    log(
      `model ready: ${this.naturalWidth}x${this.naturalHeight} scale=${model.scale.x.toFixed(3)} pos=${model.position.x.toFixed(1)},${model.position.y.toFixed(1)} textures=${model.textures.length} renderer=${this.app.renderer.type} viewport=${this.viewport().width}x${this.viewport().height}`,
    );

    return model;
  }

  /** Fits the character into the window, anchored to the bottom centre. */
  applyScale(): void {
    const model = this.model;
    if (!model) return;
    const { width, height } = this.viewport();
    const fit = Math.min(width / this.naturalWidth, height / this.naturalHeight);
    const scale = Math.max(0.05, fit * 0.98 * this.userScale);
    model.scale.set(scale);
    model.position.set(
      (width - this.naturalWidth * scale) / 2,
      height - this.naturalHeight * scale,
    );
  }

  /**
   * Size of the drawing area in CSS pixels. `stage.width` cannot be used for
   * this: it reports the bounds of the children (the model itself), not the
   * size of the window.
   */
  private viewport(): { width: number; height: number } {
    const screen = this.app.screen;
    const width = screen.width || this.app.renderer.width / this.app.renderer.resolution;
    const height = screen.height || this.app.renderer.height / this.app.renderer.resolution;
    return { width, height };
  }

  /** Makes her look at a point given in stage (css pixel) coordinates. */
  focus(x: number, y: number): void {
    // A non finite value would end up in the model parameters and the whole
    // model would stop rendering, so it is filtered out here.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.model?.focus(x, y);
  }

  /** Hit test in stage coordinates, returns the names of the hit areas. */
  hitTest(x: number, y: number): string[] {
    if (!this.model) return [];
    try {
      return this.model.hitTest(x, y);
    } catch {
      return [];
    }
  }

  /** Plays a motion group, e.g. `TapBody`. */
  motion(group: string, index = 0, priority = 3): void {
    if (!this.model) return;
    try {
      this.model.motion(group, index, priority);
      // Force mask refresh on pose change to avoid inheriting old bounding boxes
      this.lastMaskAt = 0;
    } catch {
      /* motion group not present in this model */
    }
  }

  /** Switches to an expression, e.g. `F03`. */
  expression(name: string): void {
    if (!this.model) return;
    try {
      this.model.expression(name);
      this.lastMaskAt = 0;
    } catch {
      /* expression not present in this model */
    }
  }

  /** 0 = closed mouth, 1 = wide open. */
  setMouthOpen(amount: number): void {
    this.mouthTarget = Math.max(0, Math.min(1, amount));
  }

  /** True when the given stage coordinate is covered by the character. */
  isOpaqueAt(x: number, y: number): boolean {
    const data = this.maskData;
    if (!data) return false;
    const px = Math.floor(x * this.maskScale);
    const py = Math.floor(y * this.maskScale);
    if (px < 0 || py < 0 || px >= this.maskWidth || py >= this.maskHeight) return false;
    const index = (py * this.maskWidth + px) * 4;
    return data[index + 3] > 10;
  }

  /**
   * The silhouette of the character as a list of rectangles in css pixels.
   *
   * They are used to build the window region of the desktop window: only
   * inside those rectangles the window reacts to the mouse, everywhere else
   * the click goes through to whatever is behind it.
   */
  regionRects(alphaThreshold = MASK_ALPHA_THRESHOLD): Rect[] {
    const data = this.maskData;
    if (!data || !this.maskWidth || !this.maskHeight) return [];

    // css pixels per mask pixel
    const perPixel = 1 / this.maskScale;

    // Collect the horizontal runs of every row and merge the runs that stay
    // the same over several rows, that keeps the number of rectangles low.
    type Run = { x0: number; x1: number; y0: number; y1: number };
    let active: Run[] = [];
    const finished: Run[] = [];

    for (let y = 0; y < this.maskHeight; y++) {
      const row: Run[] = [];
      const offset = y * this.maskWidth * 4;
      let start = -1;

      for (let x = 0; x < this.maskWidth; x++) {
        const opaque = data[offset + x * 4 + 3] > alphaThreshold;
        if (opaque) {
          if (start < 0) start = x;
        } else if (start >= 0) {
          row.push({ x0: start, x1: x, y0: y, y1: y });
          start = -1;
        }
      }
      if (start >= 0) row.push({ x0: start, x1: this.maskWidth, y0: y, y1: y });

      const next: Run[] = [];
      for (const run of row) {
        const previous = active.find((a) => a.x0 === run.x0 && a.x1 === run.x1);
        if (previous) {
          previous.y1 = run.y1;
          next.push(previous);
        } else {
          next.push(run);
        }
      }
      for (const run of active) {
        if (!next.includes(run)) finished.push(run);
      }
      active = next;
    }
    finished.push(...active);

    // The rectangles are enlarged slightly so that soft edges and
    // hair strands still belong to the character.
    return finished.map((run) => ({
      x: Math.floor(run.x0 * perPixel) - 1,
      y: Math.floor(run.y0 * perPixel) - 1,
      w: Math.ceil((run.x1 - run.x0) * perPixel) + 2,
      h: Math.ceil((run.y1 - run.y0 + 1) * perPixel) + 2,
    }));
  }

  /** Called from the pixi ticker. */
  tick(): void {
    // ease the mouth towards the target so it does not snap
    this.mouth += (this.mouthTarget - this.mouth) * 0.4;
    this.mouthTarget *= 0.82;
    this.applyMouth();

    const now = performance.now();
    if (now - this.lastMaskAt > MASK_INTERVAL) {
      this.lastMaskAt = now;
      this.refreshMask();
    }
  }

  private applyMouth(): void {
    const model = this.model;
    if (!model) return;
    try {
      const core = model.internalModel.coreModel as unknown as {
        setParameterValueById: (id: string, value: number) => void;
      };
      core.setParameterValueById("ParamMouthOpenY", this.mouth);
    } catch {
      /* model has no mouth parameter */
    }
  }

  private refreshMask(): void {
    const { width: viewWidth, height: viewHeight } = this.viewport();
    if (viewWidth <= 0 || viewHeight <= 0) return;

    // Keep the full sprite width in the mask to avoid right-edge clipping.
    const width = Math.max(64, Math.round(viewWidth * 1.8));
    const height = Math.max(64, Math.round((viewHeight / viewWidth) * width));

    if (!this.maskTexture || this.maskTexture.width !== width || this.maskTexture.height !== height) {
      this.maskTexture?.destroy(true);
      this.maskTexture = RenderTexture.create({ width, height, resolution: 1 });
    }

    try {
      // The stage is bigger than the mask texture, so it has to be scaled down
      // while it is rendered. Without that only the top left corner of the
      // character would end up in the mask.
      const stage = this.app.stage;
      const oldScaleX = stage.scale.x;
      const oldScaleY = stage.scale.y;
      const oldX = stage.position.x;
      const oldY = stage.position.y;
      const scale = width / viewWidth;
      stage.scale.set(scale, scale);
      stage.position.set(0, 0);

      this.app.renderer.render(stage, {
        renderTexture: this.maskTexture,
        clear: true,
      });

      stage.scale.set(oldScaleX, oldScaleY);
      stage.position.set(oldX, oldY);

      this.maskData = this.app.renderer.extract.pixels(this.maskTexture);
      this.maskWidth = width;
      this.maskHeight = height;
      this.maskScale = scale;

      let opaque = 0;
      for (let i = 3; i < this.maskData.length; i += 4) {
        if (this.maskData[i] > 10) opaque++;
      }
      this.opaquePixels = opaque;
      this.maskPixels = width * height;
      this.maskVersion++;
      if (!this.maskReported) {
        this.maskReported = true;
        const first = Array.from(this.maskData.slice(0, 16)).join(",");
        log(`mask ready: ${width}x${height} opaque=${opaque} firstBytes=${first}`);
      }
    } catch (error) {
      log(`mask refresh failed: ${error}`);
    }
  }

  destroy(): void {
    this.maskTexture?.destroy(true);
    this.maskTexture = null;
    this.maskData = null;
    this.model?.destroy();
    this.model = null;
  }
}
