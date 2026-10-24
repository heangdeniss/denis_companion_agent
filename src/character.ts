import {
  Application,
  MIPMAP_MODES,
  Point,
  RenderTexture,
  SCALE_MODES,
  Texture,
} from "pixi.js";
import { Live2DModel, MotionPreloadStrategy } from "pixi-live2d-display/cubism4";
import { log } from "./logger";
import { DEFAULT_OUTFIT } from "./outfits";
import type { OutfitEntry, OutfitTexture } from "./types";

/**
 * The texture page of the model that holds the clothes.
 *
 * Aria's model has two texture pages: `texture_00` holds the body, the head,
 * the hair and the face, `texture_01` holds the clothes (skirt, vest,
 * sleeves, scarf). The index is the position of the page in the texture list
 * of `Haru.model3.json`.
 *
 * Only this page is ever replaced when an outfit is picked. The first page
 * stays the base artwork, so her face, her hair and every expression are the
 * same in every outfit.
 */
const CLOTHING_TEXTURE_INDEX = 1;

/** How often the alpha mask is refreshed (ms). */
const MASK_INTERVAL = 95;
/** Pixels with a lower alpha are considered empty and stay click-through. */
const MASK_ALPHA_THRESHOLD = 12;
/**
 * A reaction (motion + expression) is held for this long. A second request
 * inside that window is dropped, so a motion that is still playing is never
 * restarted - that is what made her jump between the poses.
 */
const REACTION_COOLDOWN = 1600;
/**
 * The mouth follows its own rhythm while she is talking. These are the
 * frequencies of the two slow waves it is built from.
 */
const TALK_FREQUENCY_A = 8.7;
const TALK_FREQUENCY_B = 4.3;
/**
 * Height the character is drawn at when the zoom is at 100%. The overlay is
 * only as tall as she is, so a smaller window does not mean a smaller
 * character - only a wider one does.
 */
const MAX_SPRITE_HEIGHT = 480;
/** Room that is kept free above the character for the speech bubble. */
const HEAD_ROOM = 8;

/** The part of the model canvas that body space is based on. */
interface CanvasInfo {
  CanvasOriginY?: number;
  PixelsPerUnit?: number;
}

/** How long the face of an emotion tag stays before it relaxes again (ms). */
const EMOTION_HOLD = 4200;

/**
 * The expression that belongs to each emotion tag of a reply.
 *
 * The ids are the files in `assets/characters/aria/base/expressions`:
 * `F01` is the open smile, `F02` the calm resting face, `F03` the pout,
 * `F04` the blush, `F05` the closed-eye laugh, `F06` the wide-eyed surprise,
 * `F07` the shy face with `ParamTere` and `F08` the thoughtful face.
 */
const EMOTION_EXPRESSIONS: Record<string, string> = {
  happy: "F05",
  laugh: "F05",
  wink: "F05",
  smile: "F01",
  joy: "F01",
  blush: "F04",
  fluster: "F04",
  flustered: "F04",
  embarrassed: "F04",
  shy: "F04",
  pout: "F03",
  angry: "F03",
  annoyed: "F03",
  surprised: "F06",
  surprise: "F06",
  shock: "F06",
  think: "F08",
  thinking: "F08",
};

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

  /** True while she is talking. The mouth moves on its own clock then. */
  private talking = false;
  /** True while a recorded line is playing. The mouth moves with it too. */
  private voiceTalking = false;
  /** The clock of the mouth animation, in milliseconds. */
  private talkClock = 0;
  /** The moment the last reaction was played. */
  private lastReactionAt = Number.NEGATIVE_INFINITY;
  /** The last motion that was played, used to not repeat it right away. */
  private lastMotion = "";
  /** Counts the started motions, a jump in the number means a flicker. */
  motionStarts = 0;
  /** Counts the changed expressions. */
  expressionChanges = 0;

  /** Number of pixels covered by the character, refreshed with the mask. */
  opaquePixels = 0;

  /**
   * The canvas geometry of the artwork. One model unit (the unit the outfit
   * painter uses) is `ppu` canvas pixels and the middle of body space sits at
   * `originY`. It is read from the loaded model, so the mapping keeps working
   * when the model is not exactly Aria's.
   */
  private canvas = { originY: 2250, ppu: 2400 };
  private canvasRead = false;
  /** Scratch points for the stage-to-canvas conversion of a tap. */
  private readonly tapPoint = new Point();
  private readonly tapCanvas = new Point();

  /** Total number of pixels in the mask. */
  maskPixels = 0;

  private maskReported = false;

  /**
   * The atlases of the base model. They are kept so that the default outfit
   * can be put back at any time.
   */
  private baseTextures: Texture[] = [];
  /** The atlases of the outfits that were worn already. */
  private outfitTextures = new Map<string, Texture[]>();
  /** The id of the outfit she is wearing. */
  private outfitId = "default";
  /** The anisotropic filtering that is used for the atlases. */
  private anisotropy = 1;

  // ---------------------------------------------------------------- cursor tracking
  /** Target gaze in normalized model space (-1..1). */
  private gazeTargetX = 0;
  private gazeTargetY = 0;
  private gazeX = 0;
  private gazeY = 0;
  /** Last time the mouse moved inside the window. */
  private lastMouseMoveAt = 0;
  /** When true the mouse is considered idle. */
  private mouseIdle = false;
  /** Time in ms before returning to center. */
  private readonly idleTimeout = 3000;
  /** Smoothing factor for gaze interpolation. */
  private readonly gazeLerp = 0.18;
  /** Smoothing factor for returning to center. */
  private readonly centerLerp = 0.08;

  // ---------------------------------------------------------------- audio lip-sync
  /** The graph that reads the volume of a recorded line. */
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  /**
   * The source node of every element that was ever played.
   *
   * A media element can be attached to one source node only, for its whole
   * life. The nodes are kept and reused, so the same line can drive the mouth
   * again the second time it is played instead of falling back to silence.
   */
  private readonly audioSources = new Map<
    HTMLAudioElement,
    MediaElementAudioSourceNode
  >();
  /** The element whose volume drives the mouth right now, if any. */
  private currentAudioElement: HTMLAudioElement | null = null;
  /** The smoothed opening of the mouth while a line is playing. */
  private audioMouth = 0;
  /** True while a recorded line is playing and the analyser has data. */
  private useAudioMouth = false;
  /** True while streamed text is being typed out. */
  private textSpeaking = false;
  /** Phase of the simulated syllable mouth. */
  private textPhase = 0;
  /** The expression that was set by the last emotion tag. */
  private pendingExpression: string | null = null;
  /** Auto-clear timer of the emotion expression. */
  private expressionTimer: number | undefined;

  constructor(app: Application) {
    this.app = app;
    this.lastMouseMoveAt = performance.now();
  }

  async load(url: string): Promise<Live2DModel> {
    // The ticker is required, otherwise the plugin refuses to animate the
    // model. Every motion is loaded up front: a motion that has to be
    // fetched first would pop into place a moment after the click, and that
    // looks like a flicker.
    const model = await Live2DModel.from(url, {
      ticker: this.app.ticker,
      motionPreload: MotionPreloadStrategy.ALL,
    });
    this.model = model;
    this.canvasRead = false;
    this.app.stage.addChild(model);
    // The atlases of the base model are the fallback for every outfit.
    this.baseTextures = model.textures.slice();
    this.naturalWidth = model.width || 1;
    this.naturalHeight = model.height || 1;
    this.applyScale();
    this.readCanvasInfo();

    // The mouth is written right after the motions have been applied, so it
    // is not overwritten by the curves of the motion that is playing.
    const internal = model.internalModel as unknown as {
      on: (event: string, listener: () => void) => void;
      motionManager: {
        on: (event: string, listener: () => void) => void;
      };
    };
    internal.on("afterMotionUpdate", () => {
      // Both are written after the motion curves, so a swaying idle motion can
      // not pull the head or the mouth away from where they should be. The
      // physics step runs after this, so the hair and the body still follow.
      this.applyGaze();
      this.applyMouth();
    });
    // Every motion that is really started is counted. A fast growing number
    // in the heartbeat means she is changing her pose over and over again.
    internal.motionManager.on("motionStart", () => {
      this.motionStarts++;
    });

    this.optimizeTextures(model);
    this.initGaze();
    this.initAudioLipSync();

    log(
      `model ready: ${this.naturalWidth}x${this.naturalHeight} scale=${model.scale.x.toFixed(3)} pos=${model.position.x.toFixed(1)},${model.position.y.toFixed(1)} canvas=${this.canvas.originY}/${this.canvas.ppu} textures=${model.textures.length} renderer=${this.app.renderer.type} viewport=${this.viewport().width}x${this.viewport().height}`,
    );

    await this.preload();

    return model;
  }

  /**
   * Loads all motions and all expressions.
   *
   * Without it the first reaction has to wait for the network: the pose
   * would jump a moment after the click and the face would change twice.
   */
  private async preload(): Promise<void> {
    const internal = this.model?.internalModel as unknown as {
      motionManager: {
        definitions: Record<string, unknown[]>;
        loadMotion: (group: string, index: number) => Promise<unknown>;
        expressionManager?: {
          definitions: unknown[];
          loadExpression: (index: number) => Promise<unknown>;
        };
      };
    } | undefined;
    if (!internal) return;

    const manager = internal.motionManager;
    const jobs: Promise<unknown>[] = [];
    for (const group of Object.keys(manager.definitions ?? {})) {
      const count = manager.definitions[group]?.length ?? 0;
      for (let index = 0; index < count; index++) {
        jobs.push(manager.loadMotion(group, index).catch(() => undefined));
      }
    }
    const expressions = manager.expressionManager;
    if (expressions?.definitions) {
      for (let index = 0; index < expressions.definitions.length; index++) {
        jobs.push(expressions.loadExpression(index).catch(() => undefined));
      }
    }
    await Promise.all(jobs);
    log(`preloaded ${jobs.length} motions and expressions`);
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
    this.anisotropy = anisotropicLevel;

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

  /** The id of the outfit she is wearing. */
  currentOutfit(): string {
    return this.outfitId;
  }

  /**
   * Puts another outfit on her.
   *
   * An outfit is the texture page with the clothes: the file
   * `<outfit folder>/texture_01.png` is loaded and bound to the texture
   * index of the clothes. The page with the body, the head and the face is
   * never touched, so her face and her hair stay the same in every outfit.
   *
   * The mesh, the physics and the motions are not touched either, so
   * switching an outfit can never move her head or break the alignment of
   * the overlay, and the model does not have to be reloaded (a reload would
   * show a blank frame).
   *
   * When the outfit folder has no clothing page, the base clothes stay on.
   * That is a safe fallback, not an error: she is never left with a broken
   * texture.
   *
   * @param outfit the outfit to wear, `null` puts the default outfit back.
   * @param baseUrl the url of the server that serves the assets.
   * @returns false when the artwork is broken, the default outfit is worn
   *          in that case.
   */
  async setOutfit(
    outfit: OutfitEntry | null,
    baseUrl: string,
  ): Promise<boolean> {
    const model = this.model;
    if (!model) return false;

    if (!outfit || outfit.id === DEFAULT_OUTFIT) {
      this.applyTextures(this.baseTextures);
      this.outfitId = DEFAULT_OUTFIT;
      log("outfit: default");
      return true;
    }

    // Try direct binding to outfits/<id>/texture_01.png first (no CSS filters)
    try {
      const directUrl = `${baseUrl}assets/characters/aria/outfits/${encodeURIComponent(
        outfit.id,
      )}/texture_01.png`;
      const atlas = await Texture.fromURL(directUrl, {
        scaleMode: SCALE_MODES.LINEAR,
        mipmap: MIPMAP_MODES.ON,
        anisotropicLevel: this.anisotropy,
      });
      const base = this.baseTextures[CLOTHING_TEXTURE_INDEX];
      if (base && atlas.width === base.width && atlas.height === base.height) {
        const textures = this.baseTextures.slice();
        textures[CLOTHING_TEXTURE_INDEX] = atlas;
        this.applyTextures(textures);
        this.outfitId = outfit.id;
        log(`outfit: ${outfit.id} (direct texture_01.png)`);
        return true;
      }
    } catch (error) {
      log(`outfit ${outfit.id} direct texture load failed, trying fallback: ${error}`);
    }

    // Only the clothing page may be replaced. Everything else stays the base
    // artwork, that is what keeps the face and the hair intact.
    const clothing = outfit.textures.find(
      (texture) => texture.index === CLOTHING_TEXTURE_INDEX,
    );
    const ignored = outfit.textures.filter(
      (texture) => texture.index !== CLOTHING_TEXTURE_INDEX,
    );
    if (ignored.length) {
      log(
        `outfit ${outfit.id}: only the clothing page can be swapped, ${ignored.length} other page(s) are ignored`,
      );
    }

    if (!clothing) {
      // No clothing artwork in the outfit folder: fallback to base
      try {
        const fallbackUrl = `${baseUrl}assets/characters/aria/base/Haru.2048/texture_01.png`;
        const atlas = await Texture.fromURL(fallbackUrl, {
          scaleMode: SCALE_MODES.LINEAR,
          mipmap: MIPMAP_MODES.ON,
          anisotropicLevel: this.anisotropy,
        });
        const base = this.baseTextures[CLOTHING_TEXTURE_INDEX];
        if (base && atlas.width === base.width && atlas.height === base.height) {
          const textures = this.baseTextures.slice();
          textures[CLOTHING_TEXTURE_INDEX] = atlas;
          this.applyTextures(textures);
          this.outfitId = outfit.id;
          log(`outfit: ${outfit.id} (fallback to base texture_01.png)`);
          return true;
        }
      } catch (e) {
        log(`outfit fallback failed: ${e}`);
      }
      this.applyTextures(this.baseTextures);
      this.outfitId = outfit.id;
      log(
        `outfit: ${outfit.id} (no clothing artwork, the base clothes are used)`,
      );
      return true;
    }

    const textures = await this.loadOutfitTextures(outfit, clothing, baseUrl);
    if (!textures) {
      // The artwork is broken or does not fit: fallback to base
      try {
        const fallbackUrl = `${baseUrl}assets/characters/aria/base/Haru.2048/texture_01.png`;
        const atlas = await Texture.fromURL(fallbackUrl, {
          scaleMode: SCALE_MODES.LINEAR,
          mipmap: MIPMAP_MODES.ON,
          anisotropicLevel: this.anisotropy,
        });
        const base = this.baseTextures[CLOTHING_TEXTURE_INDEX];
        if (base && atlas.width === base.width && atlas.height === base.height) {
          const texturesFallback = this.baseTextures.slice();
          texturesFallback[CLOTHING_TEXTURE_INDEX] = atlas;
          this.applyTextures(texturesFallback);
          this.outfitId = outfit.id;
          log(`outfit: ${outfit.id} (fallback to base texture_01.png after load failure)`);
          return true;
        }
      } catch (e) {
        log(`outfit fallback failed: ${e}`);
      }
      return false;
    }

    this.applyTextures(textures);
    this.outfitId = outfit.id;
    log(
      `outfit: ${outfit.id} (clothing page ${CLOTHING_TEXTURE_INDEX} = ${clothing.file})`,
    );
    return true;
  }

  /**
   * Loads the clothing page of an outfit.
   *
   * The file is only fetched once, afterwards it is reused. The result is
   * `null` when the file is missing or when it is not exactly as big as the
   * page it replaces - the mesh addresses the pixels by UV coordinates, so a
   * different size would stretch the drawing.
   */
  private async loadOutfitTextures(
    outfit: OutfitEntry,
    clothing: OutfitTexture,
    baseUrl: string,
  ): Promise<Texture[] | null> {
    const cached = this.outfitTextures.get(outfit.id);
    if (cached) return cached;

    try {
      const path = clothing.file.split("/").map(encodeURIComponent).join("/");
      const url = `${baseUrl}${outfit.path}/${path}`;
      const atlas = await Texture.fromURL(url, {
        scaleMode: SCALE_MODES.LINEAR,
        mipmap: MIPMAP_MODES.ON,
        anisotropicLevel: this.anisotropy,
      });

      const base = this.baseTextures[CLOTHING_TEXTURE_INDEX];
      if (!base) {
        throw new Error(`the model has no texture page ${CLOTHING_TEXTURE_INDEX}`);
      }
      if (atlas.width !== base.width || atlas.height !== base.height) {
        throw new Error(
          `${clothing.file} is ${atlas.width}x${atlas.height}, the model needs ${base.width}x${base.height}`,
        );
      }

      // The clothing page is replaced, every other page stays the base one.
      const textures = this.baseTextures.slice();
      textures[CLOTHING_TEXTURE_INDEX] = atlas;
      this.outfitTextures.set(outfit.id, textures);
      return textures;
    } catch (error) {
      log(`outfit ${outfit.id} could not be loaded: ${error}`);
      return null;
    }
  }

  /**
   * Puts the given atlases into the model.
   *
   * The renderer binds the atlases by their index, so replacing them in place
   * is enough: the mesh, the anchor and every motion stay untouched.
   */
  private applyTextures(textures: Texture[]): void {
    const model = this.model;
    if (!model) return;
    for (let index = 0; index < model.textures.length; index++) {
      const atlas = textures[index];
      if (atlas) model.textures[index] = atlas;
    }
    // The silhouette may have changed, the hit map has to follow it.
    this.lastMaskAt = 0;
  }

  /**
   * Fits the character into the window, anchored to the bottom centre.
   *
   * The height she would like to have only depends on the width of the
   * window and on the zoom level. That way the overlay can be resized (and
   * made taller for the chat panel) without changing her size.
   */
  applyScale(): void {
    const model = this.model;
    if (!model) return;
    const { width, height } = this.viewport();
    // She is never bigger than the window, but she is not scaled down for the
    // empty space above her either.
    const room = Math.max(120, height - HEAD_ROOM);
    const target = Math.min(this.targetHeight(), room);
    const scale = Math.max(0.05, target / this.naturalHeight);
    model.scale.set(scale);
    model.position.set(
      (width - this.naturalWidth * scale) / 2,
      height - this.naturalHeight * scale,
    );
  }

  /** The height she would like to have, without looking at the window. */
  targetHeight(): number {
    const { width } = this.viewport();
    const byWidth = (width / this.naturalWidth) * this.naturalHeight;
    return Math.max(120, Math.min(MAX_SPRITE_HEIGHT * this.userScale, byWidth));
  }

  /** Height of the drawn sprite in css pixels. */
  spriteHeight(): number {
    const model = this.model;
    if (!model) return 0;
    return this.naturalHeight * model.scale.x;
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

  /** Hit test in stage coordinates, returns the names of the hit areas. */
  hitTest(x: number, y: number): string[] {
    if (!this.model) return [];
    try {
      return this.model.hitTest(x, y);
    } catch {
      return [];
    }
  }

  /**
   * Reads the canvas geometry that body space is based on.
   *
   * `CanvasOriginY` and `PixelsPerUnit` live in the moc3 and are exposed by
   * the runtime on the drawable table. The fallback values are Aria's, so a
   * failed lookup can never leave the tap mapping without a coordinate
   * system.
   */
  private readCanvasInfo(): void {
    if (this.canvasRead) return;
    this.canvasRead = true;
    const core = this.model?.internalModel.coreModel as unknown as {
      _model?: {
        canvasinfo?: CanvasInfo;
        drawables?: { canvasinfo?: CanvasInfo };
      };
    };
    const info =
      core?._model?.drawables?.canvasinfo ?? core?._model?.canvasinfo;
    if (
      info &&
      typeof info.CanvasOriginY === "number" &&
      typeof info.PixelsPerUnit === "number" &&
      info.PixelsPerUnit > 0
    ) {
      this.canvas = {
        originY: info.CanvasOriginY,
        ppu: info.PixelsPerUnit,
      };
    }
  }

  /**
   * The height of a stage point in body space, or null when the model is not
   * ready.
   *
   * Body space is the coordinate system of the outfit painter: `y = 0` is the
   * middle of the canvas and `+1` is one PixelsPerUnit above it. Her shoes
   * are at about -0.825 and the top of her hair at 0.849. The point is
   * converted with the model's own transform, so the window size and the zoom
   * are already accounted for.
   */
  bodyYAt(x: number, y: number): number | null {
    const model = this.model;
    if (!model || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    this.tapPoint.set(x, y);
    try {
      model.toModelPosition(this.tapPoint, this.tapCanvas);
    } catch {
      return null;
    }
    this.readCanvasInfo();
    const bodyY = (this.canvas.originY - this.tapCanvas.y) / this.canvas.ppu;
    return Number.isFinite(bodyY) ? bodyY : null;
  }

  /** Plays a motion group, e.g. `TapBody`. */
  motion(group: string, index = 0, priority = 3): void {
    if (!this.model) return;
    try {
      this.model.motion(group, index, priority);
      this.lastMotion = `${group}:${index}`;
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
      this.expressionChanges++;
      this.lastMaskAt = 0;
    } catch {
      /* expression not present in this model */
    }
  }

  /**
   * Goes back to the default expression.
   *
   * The expression manager blends the empty default expression in, so the
   * face relaxes over a moment instead of snapping back. The tap reactions
   * call this after a few seconds; a reaction face is not a new resting face.
   */
  clearExpression(): void {
    const manager = (
      this.model?.internalModel as unknown as {
        motionManager?: {
          expressionManager?: { resetExpression?: () => void };
        };
      }
    )?.motionManager?.expressionManager;
    if (!manager?.resetExpression) return;
    try {
      manager.resetExpression();
      this.expressionChanges++;
      this.lastMaskAt = 0;
    } catch {
      /* the model has no expression manager */
    }
  }

  /**
   * She starts talking.
   *
   * From now on the mouth moves on its own rhythm. The text stream has no
   * say in it: if every token would open the mouth again she would look like
   * she is stuttering instead of speaking.
   */
  startTalking(): void {
    if (this.talking) return;
    this.talking = true;
    log("animation: talking");
  }

  /** She stops talking, the mouth closes slowly. */
  stopTalking(): void {
    if (!this.talking) return;
    this.talking = false;
    log("animation: idle");
  }

  /**
   * Starts the mouth for a recorded line.
   *
   * This is separate from `startTalking` because a chat stream and a tap line
   * can overlap: the mouth keeps moving until both are done, and stopping one
   * of them never closes the mouth of the other.
   */
  startVoiceTalking(): void {
    this.voiceTalking = true;
  }

  /** The recorded line ended, the mouth may close now. */
  stopVoiceTalking(): void {
    this.voiceTalking = false;
  }

  // ------------------------------------------------------------ audio lip-sync

  /** Builds the analyser that reads the volume of a recorded line. */
  private initAudioLipSync(): void {
    try {
      if (typeof AudioContext === "undefined") return;
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      // A little smoothing keeps single samples from snapping the mouth.
      this.analyser.smoothingTimeConstant = 0.35;
      this.dataArray = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(this.audioContext.destination);
    } catch (error) {
      log(`audio: lip-sync is unavailable (${error})`);
      this.audioContext = null;
      this.analyser = null;
      this.dataArray = null;
    }
  }

  /**
   * Routes the element that is playing through the analyser.
   *
   * Pass `null` when the line ended: the mouth falls back to the simulated
   * rhythm and closes. The source node of an element is created once and kept,
   * because a media element can not be attached to a second source node.
   */
  attachAudioLipSync(element: HTMLAudioElement | null): void {
    if (this.currentAudioElement === element) return;
    this.currentAudioElement = element;
    this.useAudioMouth = false;

    if (!element || !this.analyser || !this.audioContext) {
      this.audioMouth = 0;
      return;
    }

    try {
      let source = this.audioSources.get(element);
      if (!source) {
        source = this.audioContext.createMediaElementSource(element);
        source.connect(this.analyser);
        this.audioSources.set(element, source);
      }
      if (this.audioContext.state === "suspended") {
        void this.audioContext.resume();
      }
      this.useAudioMouth = true;
    } catch (error) {
      log(`audio: could not attach the lip-sync (${error})`);
      this.useAudioMouth = false;
    }
  }

  /** Root-mean-square of the line, lifted into a 0..1 mouth opening. */
  private updateAudioMouth(): number {
    const analyser = this.analyser;
    const data = this.dataArray;
    if (!analyser || !data) return 0;
    try {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);
      // A recorded line is quiet compared to the full scale of a sample.
      const open = Math.min(1, rms * 6);
      this.audioMouth += (open - this.audioMouth) * 0.5;
      return this.audioMouth;
    } catch {
      return 0;
    }
  }

  /** Starts the simulated syllable mouth of a streamed reply. */
  startTextSpeaking(): void {
    if (this.textSpeaking) return;
    this.textSpeaking = true;
    this.textPhase = 0;
  }

  /** The reply is complete: the mouth closes right away. */
  stopTextSpeaking(): void {
    this.textSpeaking = false;
    // Snap mouth closed quickly when streaming ends
    this.mouth = Math.min(this.mouth, 0.05);
  }

  /** A 4-5 Hz syllable rhythm, used while no recording is playing. */
  private updateTextMouth(dt: number): number {
    const rate = 4.0 + (Math.sin(this.talkClock / 850) + 1) * 0.5;
    this.textPhase += (dt / 1000) * rate;
    const syllable =
      Math.sin(this.textPhase) * 0.6 + Math.sin(this.textPhase * 1.7) * 0.4;
    return Math.max(0, syllable) * 0.85;
  }

  /** Set mouth open value directly (for TTS lip-sync). */
  setMouthOpen(value: number): void {
    this.mouth = Math.max(0, Math.min(1, value));
  }

  // -------------------------------------------------------------- expressions

  /**
   * Sets the expression that belongs to an emotion tag of a reply.
   *
   * This is not a reaction: nothing is played and no motion is started, only
   * the face changes. It relaxes back to the default face after
   * `EMOTION_HOLD`, which is the "graceful reset while idle" of the chat.
   */
  applyEmotionExpression(tag: string): void {
    if (!this.model) return;
    const key = tag.toLowerCase().replace(/[^a-z]/g, "");
    if (!key || key === "neutral" || key === "calm") {
      this.clearEmotion();
      return;
    }
    const expression = EMOTION_EXPRESSIONS[key];
    if (!expression) return;

    this.expression(expression);
    this.pendingExpression = expression;
    window.clearTimeout(this.expressionTimer);
    this.expressionTimer = window.setTimeout(() => {
      this.pendingExpression = null;
      this.clearExpression();
      log("emotion: back to the resting face");
    }, EMOTION_HOLD);
    log(`emotion: [${key}] -> ${expression}`);
  }

  /** Drops the emotion expression before its hold has run out. */
  clearEmotion(): void {
    window.clearTimeout(this.expressionTimer);
    this.expressionTimer = undefined;
    if (!this.pendingExpression) return;
    this.pendingExpression = null;
    this.clearExpression();
  }

  /**
   * Plays a reaction: a motion and an expression.
   *
   * Only one reaction runs at a time. A second request inside the cooldown
   * is dropped, so a motion that is still playing is never restarted - that
   * is what made her jump between the poses.
   *
   * @returns true when the reaction was played.
   */
  react(motion: string | null, expression: string | null, index = 0): boolean {
    const now = performance.now();
    if (now - this.lastReactionAt < REACTION_COOLDOWN) return false;
    this.lastReactionAt = now;
    if (motion) {
      // Prefer the requested motion; fallback to TapBody if group missing
      try {
        this.motion(motion, index, 3);
      } catch {
        try {
          this.motion("TapBody", index, 3);
        } catch {
          /* ignore */
        }
      }
    }
    if (expression) this.expression(expression);
    return true;
  }

  /**
   * Starts tracking the cursor to make her head/eyes follow it.
   *
   * Coordinates are in stage/css pixels.
   */
  lookAt(x: number, y: number): void {
    if (!this.model || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.lastMouseMoveAt = performance.now();
    this.mouseIdle = false;

    const bounds = this.model.getBounds();
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;

    let tx = (x - cx) / (bounds.width / 2);
    let ty = (y - cy) / (bounds.height / 2);

    tx = Math.max(-1, Math.min(1, tx));
    ty = Math.max(-1, Math.min(1, ty));

    this.gazeTargetX = tx;
    this.gazeTargetY = -ty;
  }

  /** Called when cursor leaves the window - she will return to center. */
  lookAway(): void {
    this.mouseIdle = true;
    this.gazeTargetX = 0;
    this.gazeTargetY = 0;
  }

  private initGaze(): void {
    this.lastMouseMoveAt = performance.now();
    this.mouseIdle = true;
    this.gazeTargetX = 0;
    this.gazeTargetY = 0;
    this.gazeX = 0;
    this.gazeY = 0;
  }

  /**
   * Advances the smoothed gaze. Only the numbers are moved here; they are
   * written to the model in `applyGaze`, right after the motion update.
   */
  private updateGaze(): void {
    if (!this.model) return;
    const now = performance.now();
    if (!this.mouseIdle && now - this.lastMouseMoveAt > this.idleTimeout) {
      this.mouseIdle = true;
      this.gazeTargetX = 0;
      this.gazeTargetY = 0;
    }

    const lerp = this.mouseIdle ? this.centerLerp : Math.max(0.08, this.gazeLerp);
    this.gazeX += (this.gazeTargetX - this.gazeX) * lerp;
    this.gazeY += (this.gazeTargetY - this.gazeY) * lerp;
  }

  /**
   * Writes the gaze to the model.
   *
   * `ParamAngleX/Y` turn the head, `ParamEyeBallX/Y` move the eyes and
   * `ParamBodyAngleX` leans the body a little into the turn. The values are
   * written after the motion update and before physics, so the sway of the
   * idle motion does not undo them.
   */
  private applyGaze(): void {
    const model = this.model;
    if (!model) return;
    try {
      const core = model.internalModel.coreModel as unknown as {
        setParameterValueById: (id: string, value: number) => void;
      };
      core.setParameterValueById("ParamAngleX", this.gazeX * 30);
      core.setParameterValueById("ParamAngleY", this.gazeY * 30);
      core.setParameterValueById("ParamEyeBallX", this.gazeX);
      core.setParameterValueById("ParamEyeBallY", this.gazeY);
      core.setParameterValueById("ParamBodyAngleX", this.gazeX * 3);
    } catch {
      /* parameters may not exist on this model */
    }
  }

  /**
   * A short description of the animation state. It is written to the
   * heartbeat so a flicker is visible in the log as a rising counter.
   */
  animationState(): string {
    const internal = this.model?.internalModel as unknown as {
      motionManager?: {
        state?: {
          currentGroup?: string;
          currentIndex?: number;
          currentPriority?: number;
        };
        expressionManager?: { currentExpressionIndex?: number };
      };
    } | undefined;
    const manager = internal?.motionManager;
    const state = manager?.state;
    const expression = manager?.expressionManager?.currentExpressionIndex;
    return [
      `talk=${this.talking || this.voiceTalking || this.textSpeaking ? 1 : 0}`,
      `voice=${this.voiceTalking ? 1 : 0}`,
      `mouth=${this.mouth.toFixed(2)}`,
      `audio=${this.useAudioMouth ? this.audioMouth.toFixed(2) : "-"}`,
      `gaze=${this.gazeX.toFixed(2)},${this.gazeY.toFixed(2)}`,
      `motion=${state?.currentGroup ?? "-"}:${state?.currentIndex ?? "-"}`,
      `prio=${state?.currentPriority ?? 0}`,
      `expr=${expression ?? "-"}`,
      `starts=${this.motionStarts}`,
      `exprChanges=${this.expressionChanges}`,
      `last=${this.lastMotion || "-"}`,
    ].join(" ");
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

  /**
   * The silhouette of the character as a packed bit map: one bit per cell,
   * `1` means the cell is covered by her. The native hit test uses it to
   * decide per pixel whether a click belongs to the character.
   *
   * A cell is a few css pixels wide, which keeps the payload small enough to
   * send it to the backend a few times per second.
   */
  hitMap(cell = 2): { bits: number[]; cols: number; rows: number; cell: number } | null {
    const data = this.maskData;
    if (!data) return null;
    const { width, height } = this.viewport();
    const cols = Math.max(1, Math.ceil(width / cell));
    const rows = Math.max(1, Math.ceil(height / cell));
    const bytes = new Uint8Array(Math.ceil((cols * rows) / 8));
    const scale = this.maskScale;

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const centreX = (cx + 0.5) * cell;
        const centreY = (cy + 0.5) * cell;
        // Four samples per cell: a single hair strand is still thick enough
        // to be found.
        let opaque = false;
        for (let sy = 0; sy < 2 && !opaque; sy++) {
          for (let sx = 0; sx < 2 && !opaque; sx++) {
            const mx = Math.floor((centreX + (sx - 0.5) * cell) * scale);
            const my = Math.floor((centreY + (sy - 0.5) * cell) * scale);
            if (mx < 0 || my < 0 || mx >= this.maskWidth || my >= this.maskHeight) continue;
            if (data[(my * this.maskWidth + mx) * 4 + 3] > MASK_ALPHA_THRESHOLD) {
              opaque = true;
            }
          }
        }
        if (opaque) {
          const index = cy * cols + cx;
          bytes[index >> 3] |= 0x80 >> (index & 7);
        }
      }
    }

    return { bits: Array.from(bytes), cols, rows, cell };
  }

  /**
   * Called from the pixi ticker.
   *
   * This only advances the mouth. Nothing in here depends on the text
   * stream, so the animation keeps running at a steady rate while she is
   * speaking.
   */
  tick(dt: number): void {
    this.updateGaze();
    this.updateMouth(dt);
  }

  /**
   * The mouth is animated by a small oscillator of its own.
   *
   * Two slow waves with different lengths are mixed, that looks a lot more
   * like speech than a single sine. When she stops talking the mouth closes
   * over a moment instead of snapping shut.
   */
  private updateMouth(dt: number): void {
    let open = 0;
    if (this.useAudioMouth) {
      // Real volume of the line that is playing.
      open = this.updateAudioMouth();
    } else if (this.textSpeaking) {
      // No recording: a syllable rhythm instead, so a typed reply still has
      // a mouth that moves with it.
      this.talkClock += dt;
      open = this.updateTextMouth(dt);
    } else if (this.talking || this.voiceTalking) {
      this.talkClock += dt;
      const t = this.talkClock / 1000;
      const wave =
        Math.sin(t * TALK_FREQUENCY_A) * 0.55 +
        Math.sin(t * TALK_FREQUENCY_B + 1.1) * 0.3 +
        Math.sin(t * (TALK_FREQUENCY_A + TALK_FREQUENCY_B) * 0.6) * 0.15;
      open = 0.45 + 0.45 * wave;
    }
    // Opens quickly, closes a little slower, like a real mouth.
    this.mouth +=
      (open - this.mouth) * Math.min(1, dt / (open > this.mouth ? 45 : 160));
  }

  /**
   * Refreshes the alpha mask.
   *
   * This runs *after* the frame was drawn (a low ticker priority), so the
   * mask shows exactly what is on the screen and the extra render does not
   * interrupt the frame that is being drawn.
   */
  updateMask(): void {
    const now = performance.now();
    if (now - this.lastMaskAt <= MASK_INTERVAL) return;
    this.lastMaskAt = now;
    this.refreshMask();
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
    window.clearTimeout(this.expressionTimer);
    this.audioSources.clear();
    this.currentAudioElement = null;
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
      this.analyser = null;
      this.dataArray = null;
    }
    this.maskTexture?.destroy(true);
    this.maskTexture = null;
    this.maskData = null;
    for (const textures of this.outfitTextures.values()) {
      for (const texture of textures) {
        // The base atlases are owned by the model, they must not be destroyed
        // twice.
        if (!this.baseTextures.includes(texture)) texture.destroy(true);
      }
    }
    this.outfitTextures.clear();
    this.model?.destroy();
    this.model = null;
  }
}
