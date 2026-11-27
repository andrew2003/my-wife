import type { Clock } from "./countdown";

/** User-adjustable sound settings; the values below are only defaults. */
export interface EndSoundSettings {
  enabled: boolean;
  frequencyHz: number;
  durationMs: number;
  /** Gain from 0 to 1. */
  volume: number;
}

export const DEFAULT_END_SOUND: EndSoundSettings = {
  enabled: true,
  frequencyHz: 880,
  durationMs: 1500,
  volume: 0.5,
};

const STORAGE_KEY = "my-wife.end-sound";

/** Reads the user's saved sound settings, falling back to defaults for anything invalid. */
export function loadEndSoundSettings(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): EndSoundSettings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<EndSoundSettings>) : {};
    const num = (v: unknown, d: number, min: number, max: number) =>
      typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d;
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_END_SOUND.enabled,
      frequencyHz: num(p.frequencyHz, DEFAULT_END_SOUND.frequencyHz, 50, 5000),
      durationMs: num(p.durationMs, DEFAULT_END_SOUND.durationMs, 100, 10000),
      volume: num(p.volume, DEFAULT_END_SOUND.volume, 0, 1),
    };
  } catch {
    return DEFAULT_END_SOUND;
  }
}

/** The small part of Web Audio this feature uses, so tests can fake it. */
export interface AudioContextLike {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { value: number };
    connect(node: unknown): void;
    start(when: number): void;
    stop(when: number): void;
    disconnect(): void;
  };
  createGain(): { gain: { value: number }; connect(node: unknown): void };
}

export interface EndSound {
  /** Call from a user gesture; unlocks audio so the later sound is allowed to play. */
  unlock(): Promise<void>;
  /** Schedules one sound at `endsAtMs` on the audio clock. Repeated calls for the same end are no-ops. */
  schedule(endsAtMs: number, clock?: Clock): void;
  cancel(): void;
}

function browserContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: new () => AudioContextLike };
  return w.AudioContext ? new w.AudioContext() : null;
}

export function createEndSound(opts: {
  createContext?: () => AudioContextLike | null;
  settings?: EndSoundSettings;
}): EndSound {
  const settings = opts.settings ?? DEFAULT_END_SOUND;
  const create = opts.createContext ?? browserContext;
  let ctx: AudioContextLike | null = null;
  let scheduledFor: number | null = null;
  let osc: ReturnType<AudioContextLike["createOscillator"]> | null = null;
  return {
    async unlock() {
      if (!settings.enabled) return;
      ctx ??= create();
      if (ctx && ctx.state !== "running") await ctx.resume();
    },
    schedule(endsAtMs, clock = { now: () => Date.now() }) {
      if (!settings.enabled || !ctx || ctx.state !== "running") return;
      if (scheduledFor === endsAtMs) return;
      scheduledFor = endsAtMs;
      const delay = Math.max(0, endsAtMs - clock.now()) / 1000;
      const at = ctx.currentTime + delay;
      const gain = ctx.createGain();
      gain.gain.value = settings.volume;
      gain.connect(ctx.destination);
      osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = settings.frequencyHz;
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + settings.durationMs / 1000);
    },
    cancel() {
      if (osc) {
        osc.stop(0);
        osc.disconnect();
        osc = null;
      }
      scheduledFor = null;
    },
  };
}
