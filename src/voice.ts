import { log } from "./logger";

/**
 * The folders below `assets/characters/<name>/sounds/`.
 *
 * A group is a set of recorded lines: `headpat` for the top of her head,
 * `poke` for her face, `flustered` for the chest and the waist and `surprise`
 * for the skirt and the legs.
 */
export type VoiceGroup = "headpat" | "poke" | "flustered" | "surprise";

export const VOICE_GROUPS: VoiceGroup[] = [
  "headpat",
  "poke",
  "flustered",
  "surprise",
];

/** Volume of a line, 0..1. `setVolume` changes it while a line is playing. */
const DEFAULT_VOLUME = 0.85;

/**
 * A group that is not listed in `index.json` still plays this file, so a
 * folder with a single `line1.wav` works without a manifest entry.
 */
const FALLBACK_LINE = "line1.wav";

interface VoiceHooks {
  /**
   * Called with the element that is about to play, before it starts.
   *
   * This runs inside the click that started the line, which is the moment the
   * audio context may be resumed by the browser.
   */
  onElement?: (element: HTMLAudioElement) => void;
  /** Called when the line is really audible (not just started). */
  onStart?: () => void;
  /** Called when the line ended, failed or was stopped. */
  onEnd?: () => void;
}

interface Clip {
  url: string;
  audio: HTMLAudioElement;
}

/**
 * Plays the recorded lines of the character.
 *
 * Only one line can play at a time: a new one stops the old one first, so two
 * taps can never end up talking over each other. The lip-sync hooks are tied
 * to the element that is playing by a token, so a late event of an element
 * that was stopped can not close the mouth of the next line.
 */
export class Voice {
  /** Root url of the sounds folder, always with a trailing slash. */
  private root = "";
  private clips = new Map<VoiceGroup, Clip[]>();
  private lastLine: Partial<Record<VoiceGroup, string>> = {};
  private current: Clip | null = null;
  private hooks: VoiceHooks = {};
  private token = 0;

  /** Volume of every line that is started from now on, 0..1. */
  volume = DEFAULT_VOLUME;
  /** Setting this to false mutes the lines without touching the animation. */
  enabled = true;

  /** True while a recorded line is audible. */
  get speaking(): boolean {
    return this.current !== null;
  }

  /**
   * The element that is playing right now, or null.
   *
   * The lip-sync needs the same element the sound comes from: an analyser on a
   * different element would read silence.
   */
  get element(): HTMLAudioElement | null {
    return this.current?.audio ?? null;
  }

  /** Number of lines that were found, for the boot log. */
  get lineCount(): number {
    let count = 0;
    for (const clips of this.clips.values()) count += clips.length;
    return count;
  }

  /**
   * Loads `index.json` and preloads every line.
   *
   * Preloading matters: the first tap of a session has to sound at the same
   * moment as the motion, otherwise the delay is noticeable. A missing
   * manifest is not an error - the conventional `line1.wav` of every group is
   * tried instead.
   */
  async attach(soundsUrl: string): Promise<void> {
    this.root = soundsUrl.endsWith("/") ? soundsUrl : `${soundsUrl}/`;
    const manifest = await this.readManifest();
    this.clips.clear();

    for (const group of VOICE_GROUPS) {
      const files = manifest[group] ?? [`${group}/${FALLBACK_LINE}`];
      const clips: Clip[] = [];
      for (const file of files) {
        const url =
          this.root + file.split("/").map(encodeURIComponent).join("/");
        // The sounds come from the asset server, the page from another origin.
        // The anonymous flag makes the media request CORS-enabled, which is
        // what the lip-sync analyser needs to be allowed to read it.
        const audio = new Audio();
        audio.crossOrigin = "anonymous";
        audio.src = url;
        audio.preload = "auto";
        audio.volume = this.volume;
        try {
          // `load` starts the request right away instead of waiting for the
          // first play, which is what keeps the first reaction in sync.
          audio.load();
        } catch {
          /* the element still works, it just loads on play */
        }
        clips.push({ url, audio });
      }
      if (clips.length) this.clips.set(group, clips);
    }

    log(`voice: ${this.lineCount} line(s) from ${this.root}`);
  }

  /** Changes the volume, including the line that is playing right now. */
  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.current) this.current.audio.volume = this.volume;
  }

  /**
   * Plays a line of the group.
   *
   * @returns false when the group has no playable line (the caller can then
   *          animate the mouth for the length of the text instead).
   */
  say(group: VoiceGroup, hooks: VoiceHooks = {}): boolean {
    if (!this.enabled) return false;
    const clips = this.clips.get(group);
    const clip = clips ? this.pickClip(group, clips) : null;
    if (!clip) return false;

    this.stop();
    this.current = clip;
    this.hooks = hooks;
    this.lastLine[group] = clip.url;
    const token = ++this.token;

    const audio = clip.audio;
    audio.volume = this.volume;
    // The tap that starts the line is still a user gesture here, which is the
    // only moment the AudioContext may be resumed. Doing this before `play`
    // also means the mouth is ready for the first syllable.
    try {
      hooks.onElement?.(audio);
    } catch (error) {
      log(`voice: the lip-sync hook failed (${error})`);
    }
    audio.onplaying = () => {
      if (token === this.token) this.hooks.onStart?.();
    };
    audio.onended = () => {
      if (token === this.token) this.finish();
    };
    audio.onerror = () => {
      if (token === this.token) {
        log(`voice: could not play ${clip.url}`);
        this.finish();
      }
    };

    try {
      audio.currentTime = 0;
      const started = audio.play();
      if (started) {
        started.catch((error) => {
          if (token !== this.token) return;
          log(`voice: playback refused (${error})`);
          this.finish();
        });
      }
    } catch (error) {
      log(`voice: playback failed (${error})`);
      this.finish();
      return false;
    }

    log(`voice: ${clip.url.split("/").pop()}`);
    return true;
  }

  /** Stops the line that is playing, if any. */
  stop(): void {
    const clip = this.current;
    if (!clip) return;
    this.token++;
    this.current = null;
    clip.audio.onplaying = null;
    clip.audio.onended = null;
    clip.audio.onerror = null;
    try {
      clip.audio.pause();
      clip.audio.currentTime = 0;
    } catch {
      /* the element may not have started yet */
    }
    const hooks = this.hooks;
    this.hooks = {};
    hooks.onEnd?.();
  }

  private finish(): void {
    this.current = null;
    const hooks = this.hooks;
    this.hooks = {};
    hooks.onEnd?.();
  }

  /** A line that is not the same as the one that played last, when possible. */
  private pickClip(group: VoiceGroup, clips: Clip[]): Clip | null {
    if (!clips.length) return null;
    if (clips.length === 1) return clips[0];
    const last = this.lastLine[group];
    const fresh = clips.filter((clip) => clip.url !== last);
    const pool = fresh.length ? fresh : clips;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private async readManifest(): Promise<Partial<Record<VoiceGroup, string[]>>> {
    try {
      const response = await fetch(`${this.root}index.json`, {
        cache: "no-store",
      });
      if (!response.ok) {
        log(`voice: no index.json (${response.status})`);
        return {};
      }
      const data = (await response.json()) as {
        lines?: Record<string, unknown>;
      };
      const lines = data?.lines ?? {};
      const manifest: Partial<Record<VoiceGroup, string[]>> = {};
      for (const group of VOICE_GROUPS) {
        const value = lines[group];
        if (!Array.isArray(value)) continue;
        const files = value.filter(
          (file): file is string => typeof file === "string" && file.length > 0,
        );
        if (files.length) manifest[group] = files;
      }
      return manifest;
    } catch (error) {
      log(`voice: index.json could not be read (${error})`);
      return {};
    }
  }
}
