import { Application, MIPMAP_MODES, RenderTexture, SCALE_MODES } from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import { log } from "./logger";

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
  /** Top-center of the visible silhouette in css pixels, updated with the mask. */
  private head = { x: 0, y: 0, valid: false };
  private mouth = 0;
  private mouthTarget = 0;
  private events: CharacterEvents = {};

  /** Number of pixels covered by the character, refreshed with the mask. */
  opaquePixels = 0;

  /** Total number of pixels in the mask. */
  maskPixels = 0;

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

    this.optimizeTextures(model);

    log(
      `model ready: ${this.naturalWidth}x${this.naturalHeight} scale=${model.scale.x.toFixed(3)} pos=${model.position.x.toFixed(1)},${model.position.y.toFixed(1)} textures=${model.textures.length} renderer=${this.app.renderer.type} viewport=${this.viewport().width}x${this.viewport().height}`,
    );

    return model;
  }

  /**
   * The artwork is authored at 2048x2048 but is usually painted much smaller
   * on screen. Mipmaps plus anisotropic filtering keep the downscaled
   * texture smooth while the model moves instead of shimmering/pixelating.
   */
  private optimizeTextures(model: Live2DModel): void {
    const gl = (this.app.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
    let maxAnisotropy = 1;
    if (gl) {
      const ext = gl.getExtension("EXT_texture_filter_anisotropic");
      if (ext) {
        maxAnisotropy = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      }
    }
    const anisotropicLevel = Math.max(1, Math.min(8, maxAnisotropy));

    for (const texture of model.textures) {
      const base = texture.baseTexture;
      base.scaleMode = SCALE_MODES.LINEAR;
      base.mipmap = MIPMAP_MODES.ON;
      base.anisotropicLevel = anisotropicLevel;
    }

    log(
      `textures: ${model.textures.length}, linear filter, mipmaps on, anisotropy ${anisotropicLevel}x`,
    );
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

  /**
   * True when the given stage coordinate is covered by the character.
   *
   * This is the hit-test used for click-through. The window is never clipped
   * to this mask, so the rendered edge stays anti-aliased; only the mouse
   * handling is decided from it.
   */
  isOpaqueAt(x: number, y: number): boolean {
    const data = this.maskData;
    if (!data) return false;
    const px = Math.floor(x * this.maskScale);
    const py = Math.floor(y * this.maskScale);
    if (px < 0 || py < 0 || px >= this.maskWidth || py >= this.maskHeight) return false;
    const index = (py * this.maskWidth + px) * 4;
    return data[index + 3] > MASK_ALPHA_THRESHOLD;
  }

  /**
   * Where the speech bubble should sit: the top-center of her visible head in
   * css pixels. Falls back to the sprite bounds until the first mask is ready.
   */
  headAnchor(): { x: number; y: number } {
    if (this.head.valid) return { x: this.head.x, y: this.head.y };
    const model = this.model;
    if (model) {
      const bounds = model.getBounds();
      return { x: bounds.x + bounds.width / 2, y: bounds.y };
    }
    const { width, height } = this.viewport();
    return { x: width / 2, y: height * 0.45 };
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
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
          if (this.maskData[row + x * 4 + 3] > MASK_ALPHA_THRESHOLD) {
            opaque++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      this.opaquePixels = opaque;
      this.maskPixels = width * height;

      if (maxX >= minX && maxY >= minY) {
        // Her head is the top slice of the silhouette. The average x of the
        // opaque pixels in that slice keeps the bubble over the head instead
        // of the bounding box centre when the pose is tilted.
        const headEnd = Math.min(
          maxY,
          minY + Math.max(6, Math.round((maxY - minY) * 0.14)),
        );
        let sum = 0;
        let count = 0;
        for (let y = minY; y <= headEnd; y += 2) {
          const row = y * width * 4;
          for (let x = minX; x <= maxX; x += 2) {
            if (this.maskData[row + x * 4 + 3] > MASK_ALPHA_THRESHOLD) {
              sum += x;
              count++;
            }
          }
        }
        const inv = 1 / scale;
        this.head = {
          x: (count > 0 ? sum / count : (minX + maxX) / 2) * inv,
          y: minY * inv,
          valid: true,
        };
      }

      if (!this.maskReported) {
        this.maskReported = true;
        const first = Array.from(this.maskData.slice(0, 16)).join(",");
        log(
          `mask ready: ${width}x${height} opaque=${opaque} head=${this.head.x.toFixed(0)},${this.head.y.toFixed(0)} firstBytes=${first}`,
        );
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
