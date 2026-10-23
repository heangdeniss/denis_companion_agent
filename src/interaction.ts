import type { Character } from "./character";
import { log } from "./logger";
import { Voice, type VoiceGroup } from "./voice";

/**
 * The parts of her body that answer a tap.
 *
 * The model only has two native hit areas, "Head" and "Body", so the fine
 * split is done in body space - the same coordinate system the outfit painter
 * uses: y = 0 is the middle of the canvas, +1 is one PixelsPerUnit above it
 * and the visible figure spans about -0.825 (the shoes) to 0.849 (the top of
 * the hair).
 */
export type BodyRegion = "head" | "face" | "chest" | "torso" | "legs";

/**
 * Upper bounds of the regions in body space.
 *
 * Derived from the mesh of the model, not guessed: the brow line sits at
 * 0.70, the chin at 0.573, the bust at 0.43, the waist at 0.202 and the skirt
 * hem at -0.201. Everything below the waist is the skirt and the legs, which
 * is why that region is the largest one.
 */
export const REGION_BOUNDS = {
  head: 0.7,
  face: 0.573,
  chest: 0.43,
  torso: 0.202,
} as const;

/** The region that contains the given body-space height. */
export function regionAt(bodyY: number): BodyRegion {
  if (bodyY >= REGION_BOUNDS.head) return "head";
  if (bodyY >= REGION_BOUNDS.face) return "face";
  if (bodyY >= REGION_BOUNDS.chest) return "chest";
  if (bodyY >= REGION_BOUNDS.torso) return "torso";
  return "legs";
}

/** One spoken line with the animation that belongs to it. */
export interface RegionReaction {
  /** Short name for the log and the dev tools. */
  label: string;
  /** Motion group and index in `Haru.model3.json`. */
  motion: { group: string; index: number };
  /** Expression id, e.g. `F05`. */
  expression: string;
  /** Folder below `sounds/`. */
  voice: VoiceGroup;
  lines: string[];
}

/**
 * The reaction table.
 *
 * The model has no `Haru-pose3` motion group, so the animations are the ones
 * that are really in the model: `Idle` (a gentle sway) and the four `TapBody`
 * motions. The expressions come from the parameter sets of the `.exp3.json`
 * files: F05 is the closed-eye happy face, F03 the pout, F07 the shy face
 * with `ParamTere` and F06 the wide-eyed surprise.
 */
export const REACTIONS: Record<BodyRegion, RegionReaction> = {
  head: {
    label: "head/hair",
    motion: { group: "Idle", index: 1 },
    expression: "F05",
    voice: "headpat",
    lines: [
      "Ehehe, that tickles~",
      "Patting my head? Thank you!",
      "Mmm... a little more, please~",
      "Nn... that feels nice...",
    ],
  },
  face: {
    label: "face/cheeks",
    motion: { group: "TapBody", index: 1 },
    expression: "F03",
    voice: "poke",
    lines: [
      "Hey! Don't squish my cheeks~",
      "Mou~ my face is not a toy!",
      "Poke me again and I'll bite!",
      "H-hey! Not the cheeks!",
    ],
  },
  chest: {
    label: "chest/ribbon",
    motion: { group: "TapBody", index: 0 },
    expression: "F07",
    voice: "flustered",
    lines: [
      "W-what are you doing?! Hands to yourself!",
      "H-hey! Not there!",
      "Eek! W-warn me first!",
      "Th-that is not fair...",
    ],
  },
  torso: {
    label: "torso/waist",
    motion: { group: "TapBody", index: 3 },
    expression: "F07",
    voice: "flustered",
    lines: [
      "H-hey, that tickles!",
      "C-careful, I'm ticklish there!",
      "Wh-what are you poking at?!",
      "S-stop that, it's cheating...",
    ],
  },
  legs: {
    label: "skirt/legs",
    motion: { group: "TapBody", index: 2 },
    expression: "F06",
    voice: "surprise",
    lines: [
      "Down there? Be careful!",
      "H-hey! D-don't look!",
      "M-my legs?! Perv!",
      "Eek! What are you doing down there?",
    ],
  },
};

/** A tap inside this window is dropped, so the audio can not stack. */
const TAP_COOLDOWN = 1900;
/** The reaction expression is put back after this long. */
const EXPRESSION_HOLD = 3600;

export interface TapLocation {
  /** The region under the point, or null when the model is not loaded. */
  region: BodyRegion | null;
  /** The height in body space, or null when it can not be computed. */
  bodyY: number | null;
}

export interface TapResult extends TapLocation {
  region: BodyRegion;
  bodyY: number;
  line: string;
}

export interface InteractionOptions {
  character: Character;
  voice: Voice;
  /** Shows the line in the bubble and the chat log. */
  say: (line: string) => void;
}

/**
 * Maps a tap to a body region and plays the matching reaction.
 *
 * The motion and the expression are handed to the character, which has its own
 * cooldown for them. The line and the recording are only played when that
 * reaction was really started, so the voice can never run while the motion is
 * still in its old pose.
 */
export class Interaction {
  private lastTapAt = Number.NEGATIVE_INFINITY;
  private lastLine: Partial<Record<BodyRegion, string>> = {};
  private expressionTimer: number | undefined;
  private mouthTimer: number | undefined;

  constructor(private readonly options: InteractionOptions) {}

  /** Where a stage point lands, without playing anything. */
  locate(x: number, y: number): TapLocation {
    const bodyY = this.options.character.bodyYAt(x, y);
    return {
      region: bodyY === null ? null : regionAt(bodyY),
      bodyY,
    };
  }

  /**
   * Handles a click on the character.
   *
   * @param x stage x in css pixels
   * @param y stage y in css pixels
   * @param hitAreas the names the native hit test returned, for the log
   * @returns the reaction that was played, or null when the tap was dropped
   */
  tap(x: number, y: number, hitAreas: string[] = []): TapResult | null {
    const now = performance.now();
    const waited = now - this.lastTapAt;
    if (waited < TAP_COOLDOWN) {
      log(`tap ignored: ${Math.round(TAP_COOLDOWN - waited)} ms of cooldown left`);
      return null;
    }
    // The previous line is still running: the next one would cut it off and
    // the two recordings would overlap at the edges.
    if (this.options.voice.speaking) {
      log("tap ignored: the previous line is still playing");
      return null;
    }

    const location = this.locate(x, y);
    if (!location.region || location.bodyY === null) {
      log(`tap ignored: no body region at ${x.toFixed(0)},${y.toFixed(0)}`);
      return null;
    }

    this.lastTapAt = now;
    const region = location.region;
    const reaction = REACTIONS[region];
    const started = this.options.character.react(
      reaction.motion.group,
      reaction.expression,
      reaction.motion.index,
    );
    if (!started) {
      // A reaction is still running. No line, no sound, no bubble either.
      log(`tap ignored: ${reaction.label} is still reacting`);
      return null;
    }

    const line = this.pickLine(region, reaction.lines);
    this.options.say(line);

    const spoken = this.options.voice.say(reaction.voice, {
      onStart: () => this.options.character.startVoiceTalking(),
      onEnd: () => this.options.character.stopVoiceTalking(),
    });
    if (!spoken) {
      // There is no recording for this region: the mouth still moves while
      // the line is on screen, so the reaction never looks silent.
      this.options.character.startVoiceTalking();
      window.clearTimeout(this.mouthTimer);
      const duration = Math.min(3600, Math.max(1300, 900 + line.length * 45));
      this.mouthTimer = window.setTimeout(() => {
        this.options.character.stopVoiceTalking();
      }, duration);
    }

    // The expression is a reaction, not a new face: after a few seconds she
    // goes back to the default expression on her own.
    window.clearTimeout(this.expressionTimer);
    this.expressionTimer = window.setTimeout(() => {
      this.options.character.clearExpression();
    }, EXPRESSION_HOLD);

    log(
      `tap: ${reaction.label} at body y=${location.bodyY.toFixed(3)} native=${
        hitAreas.join(",") || "-"
      } line="${line}"${spoken ? " voice=1" : " voice=0"}`,
    );
    return { ...location, region, bodyY: location.bodyY, line };
  }

  /** Stops the timers, used when the app is going away. */
  dispose(): void {
    window.clearTimeout(this.expressionTimer);
    window.clearTimeout(this.mouthTimer);
    this.options.voice.stop();
    this.options.character.stopVoiceTalking();
  }

  private pickLine(region: BodyRegion, lines: string[]): string {
    const last = this.lastLine[region];
    const fresh = lines.length > 1 ? lines.filter((l) => l !== last) : lines;
    const pool = fresh.length ? fresh : lines;
    const line = pool[Math.floor(Math.random() * pool.length)];
    this.lastLine[region] = line;
    return line;
  }
}
