import { api } from "./ipc";
import { log } from "./logger";

export type TTSOptions = {
  onStart?: () => void;
  onEnd?: () => void;
  onMouth?: (value: number) => void;
};

const STORAGE_KEY = "eiwaifu:voiceMuted";

function getMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
  } catch {}
}

export function isMuted(): boolean {
  return getMuted();
}

function stripEmotionTags(text: string): string {
  let t = text;
  // Remove a leading emotion tag, then any other simple tags in the line.
  t = t.replace(/^\s*\[[a-zA-Z]+\]\s*/g, "");
  t = t.replace(/\[[a-zA-Z]+\]/g, "");
  return t.trim();
}

/**
 * Speaks a line with the in-folder Piper voice when it is available and falls
 * back to the system voices otherwise.
 *
 * Both paths go through the same `AnalyserNode`, so `ParamMouthOpenY` is driven
 * by the actual audio instead of a guess. The procedural mouth in `character.ts`
 * stays in charge while a reply is still streaming.
 */
export class TTS {
  private synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private source: AudioBufferSourceNode | null = null;
  private raf: number | null = null;
  private speaking = false;
  /** The system voice is not routed through WebAudio, so the analyser would
   * read silence. In that case the mouth is driven procedurally instead. */
  private proceduralMouth = false;
  private muted = getMuted();
  /** Bumped on every stop, so a late async result cannot start stale audio. */
  private token = 0;

  isSpeaking(): boolean {
    return this.speaking;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    setMuted(muted);
    if (muted) this.stop();
  }

  getMuted(): boolean {
    return this.muted;
  }

  private ensureAudio(): void {
    if (this.audioContext) return;
    try {
      if (typeof AudioContext === "undefined") return;
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.4;
      this.dataArray = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(this.audioContext.destination);
    } catch (e) {
      log(`tts: audio context failed ${e}`);
      this.audioContext = null;
      this.analyser = null;
      this.dataArray = null;
    }
  }

  private startLipSync(onMouth?: (v: number) => void): void {
    this.ensureAudio();
    if (!this.analyser || !this.dataArray || !onMouth) return;
    const loop = () => {
      if (!this.speaking || !this.analyser || !this.dataArray) {
        if (this.raf != null) {
          cancelAnimationFrame(this.raf);
          this.raf = null;
        }
        onMouth(0);
        return;
      }
      try {
        if (this.proceduralMouth) {
          const t = performance.now() / 1000;
          const open = 0.42 + 0.3 * Math.sin(t * 2 * Math.PI * 4.5);
          onMouth(Math.max(0.05, Math.min(0.85, open)));
        } else {
          this.analyser.getByteTimeDomainData(this.dataArray);
          let sum = 0;
          for (let i = 0; i < this.dataArray.length; i++) {
            const v = (this.dataArray[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / this.dataArray.length);
          // Speech has short gaps: a little lift keeps the mouth visibly moving.
          const open = Math.min(1, rms * 7.5);
          onMouth(open);
        }
      } catch {}
      this.raf = requestAnimationFrame(loop);
    };
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  private stopLipSync(onMouth?: (v: number) => void): void {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (onMouth) onMouth(0);
  }

  /**
   * Renders the line with Piper inside the app and plays the returned WAV.
   * Returns false when the local stack is not installed, so the caller can
   * fall back to the system voice.
   */
  private async speakLocal(
    text: string,
    options: TTSOptions,
    token: number,
  ): Promise<boolean> {
    let url = "";
    try {
      url = await api.speakLocal(text);
    } catch (e) {
      log(`tts: local voice failed ${e}`);
      return false;
    }
    if (token !== this.token) return true;
    if (!url || !url.startsWith("data:audio")) return false;

    this.ensureAudio();
    const ctx = this.audioContext;
    const analyser = this.analyser;
    if (!ctx || !analyser) return false;

    try {
      if (ctx.state === "suspended") await ctx.resume();
      const response = await fetch(url);
      const data = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      if (token !== this.token) return true;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      this.source = source;

      this.speaking = true;
      options.onStart?.();
      this.proceduralMouth = false;
      this.startLipSync(options.onMouth);

      source.onended = () => {
        if (this.source !== source) return;
        this.source = null;
        this.speaking = false;
        this.stopLipSync(options.onMouth);
        options.onEnd?.();
      };
      source.start();
      return true;
    } catch (e) {
      log(`tts: local playback failed ${e}`);
      return false;
    }
  }

  private speakSystem(text: string, options: TTSOptions): void {
    if (!this.synth) {
      options.onEnd?.();
      return;
    }
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      utter.pitch = 1.15;
      utter.volume = 1.0;
      const voices = this.synth.getVoices();
      const preferred = voices.find(
        (v) =>
          /female|zira|samantha|victoria|jenny|aria/i.test(v.name) ||
          /en-US/i.test(v.lang),
      );
      if (preferred) utter.voice = preferred;

      this.speaking = true;
      utter.onstart = () => {
        options.onStart?.();
        this.proceduralMouth = true;
        this.startLipSync(options.onMouth);
        if (this.audioContext?.state === "suspended") {
          void this.audioContext.resume();
        }
      };
      utter.onend = () => {
        this.speaking = false;
        this.stopLipSync(options.onMouth);
        options.onEnd?.();
      };
      utter.onerror = () => {
        this.speaking = false;
        this.stopLipSync(options.onMouth);
        options.onEnd?.();
      };
      this.synth.speak(utter);
    } catch (e) {
      log(`tts: speak failed ${e}`);
      options.onEnd?.();
    }
  }

  speak(text: string, options: TTSOptions = {}): void {
    const cleaned = stripEmotionTags(text);
    if (this.muted || !cleaned) {
      // No audio, but the caller still wants to know that the line is over.
      options.onStart?.();
      options.onEnd?.();
      return;
    }

    this.stop();
    const token = this.token;

    void this.speakLocal(cleaned, options, token).then((ok) => {
      if (ok || token !== this.token) return;
      log("tts: local voice unavailable, using system voice");
      this.speakSystem(cleaned, options);
    });
  }

  stop(): void {
    this.token++;
    try {
      if (this.synth) this.synth.cancel();
    } catch {}
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
        this.source.disconnect();
      } catch {}
      this.source = null;
    }
    this.speaking = false;
    this.stopLipSync();
  }
}

export const tts = new TTS();
