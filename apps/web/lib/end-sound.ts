import type { Clock } from "./countdown";

/** User-adjustable sound settings; the values below are only defaults. */
export interface EndSoundSettings {
  enabled: boolean;
  frequencyHz: number;
  durationMs: number;
  /** Gain from 0 to 1. */
  volume: number;
  /** An end past by more than this is not announced (the moment is gone). */
  maxLatenessMs: number;
}

export const DEFAULT_END_SOUND: EndSoundSettings = {
  enabled: true,
  frequencyHz: 880,
  durationMs: 1500,
  volume: 0.5,
  maxLatenessMs: 5000,
};

/** Accepted ranges for the numeric settings; anything outside falls back to the default. */
export const END_SOUND_BOUNDS = {
  frequencyHz: { min: 50, max: 5000 },
  durationMs: { min: 100, max: 10_000 },
  volume: { min: 0, max: 1 },
  maxLatenessMs: { min: 0, max: 600_000 },
} as const;

/** A moved audio time smaller than this (seconds) is jitter, not a reschedule. */
export const RESCHEDULE_TOLERANCE_SECONDS = 0.25;

export const END_SOUND_STORAGE_KEY = "my-wife.end-sound";

/** Reads the user's saved sound settings, falling back to defaults for anything invalid. */
export function loadEndSoundSettings(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): EndSoundSettings {
  try {
    const raw = storage?.getItem(END_SOUND_STORAGE_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<EndSoundSettings>) : {};
    const num = (k: keyof typeof END_SOUND_BOUNDS) => {
      const v = p[k];
      const { min, max } = END_SOUND_BOUNDS[k];
      return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
        ? v
        : DEFAULT_END_SOUND[k];
    };
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_END_SOUND.enabled,
      frequencyHz: num("frequencyHz"),
      durationMs: num("durationMs"),
      volume: num("volume"),
      maxLatenessMs: num("maxLatenessMs"),
    };
  } catch {
    return DEFAULT_END_SOUND;
  }
}

/** Persists the settings; silently ignores a blocked or full storage. */
export function saveEndSoundSettings(
  storage: Pick<Storage, "setItem"> | undefined,
  settings: EndSoundSettings,
): void {
  try {
    storage?.setItem(END_SOUND_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // the setting then lasts only for this page
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
  /** Schedules one sound at `endsAtMs` on the audio clock; moves it when the end or audio time shifts. */
  schedule(endsAtMs: number, clock?: Clock): void;
  /** Applies new settings and drops any scheduled tone. */
  configure(settings: EndSoundSettings): void;
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
  let settings = opts.settings ?? DEFAULT_END_SOUND;
  const create = opts.createContext ?? browserContext;
  let ctx: AudioContextLike | null = null;
  let scheduled: { endsAtMs: number; at: number } | null = null;
  let osc: ReturnType<AudioContextLike["createOscillator"]> | null = null;
  const cancel = () => {
    if (osc) {
      osc.stop(0);
      osc.disconnect();
      osc = null;
    }
    scheduled = null;
  };
  return {
    async unlock() {
      if (!settings.enabled) return;
      ctx ??= create();
      if (ctx && ctx.state !== "running") await ctx.resume();
    },
    schedule(endsAtMs, clock = { now: () => Date.now() }) {
      if (!settings.enabled || !ctx || ctx.state !== "running") return;
      // The tone for this end already started: never replay it, whatever a resync says.
      if (scheduled && scheduled.endsAtMs === endsAtMs && scheduled.at <= ctx.currentTime) return;
      const remainingMs = endsAtMs - clock.now();
      if (remainingMs < -settings.maxLatenessMs) {
        cancel();
        return;
      }
      const at = ctx.currentTime + Math.max(0, remainingMs) / 1000;
      if (
        scheduled &&
        scheduled.endsAtMs === endsAtMs &&
        Math.abs(scheduled.at - at) <= RESCHEDULE_TOLERANCE_SECONDS
      ) {
        return;
      }
      cancel();
      scheduled = { endsAtMs, at };
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
    configure(next) {
      cancel();
      settings = next;
    },
    cancel,
  };
}
