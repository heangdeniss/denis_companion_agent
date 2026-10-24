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
  // Remove leading emotion tags like [happy] [blush] etc
  let t = text;
  t = t.replace(/^\s*\[[a-zA-Z]+\]\s*/g, "");
  // Also strip any remaining simple tags
  t = t.replace(/\[[a-zA-Z]+\]/g, "");
  return t.trim();
}

export class TTS {
  private synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private raf: number | null = null;
  private speaking = false;
  private muted = getMuted();

  isSpeaking(): boolean {
    return this.speaking;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    setMuted(muted);
    if (muted) {
      this.stop();
    }
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
        this.analyser.getByteTimeDomainData(this.dataArray);
        let sum = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
          const v = (this.dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this.dataArray.length);
        const open = Math.min(1, rms * 7);
        onMouth(open);
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

  speak(text: string, options: TTSOptions = {}): void {
    if (this.muted) {
      options.onStart?.();
      // still allow procedural lip sync via text if needed? just skip audio
      options.onEnd?.();
      return;
    }
    if (!this.synth) {
      options.onStart?.();
      options.onEnd?.();
      return;
    }
    try {
      this.stop();
      const cleaned = stripEmotionTags(text);
      if (!cleaned) {
        options.onEnd?.();
        return;
      }
      const utter = new SpeechSynthesisUtterance(cleaned);
      utter.rate = 1.0;
      utter.pitch = 1.15;
      utter.volume = 1.0;
      // Try to pick a female/anime voice
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

  stop(): void {
    try {
      if (this.synth) {
        this.synth.cancel();
      }
    } catch {}
    this.speaking = false;
    this.stopLipSync();
  }
}

export const tts = new TTS();
