import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_END_SOUND,
  END_SOUND_BOUNDS,
  END_SOUND_STORAGE_KEY,
  createEndSound,
  loadEndSoundSettings,
  saveEndSoundSettings,
  type AudioContextLike,
} from "../lib/end-sound";

function fakeAudio(state = "running") {
  const starts: number[] = [];
  const osc = {
    type: "sine",
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn((t: number) => void starts.push(t)),
    stop: vi.fn(),
    disconnect: vi.fn(),
  };
  const ctx: AudioContextLike = {
    state,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => {
      ctx.state = "running";
    }),
    createOscillator: vi.fn(() => osc),
    createGain: vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn() })),
  };
  return { ctx, osc, starts };
}

describe("end sound lateness", () => {
  it("plays when slightly late, skips when later than the setting", async () => {
    const a = fakeAudio();
    const sound = createEndSound({ createContext: () => a.ctx });
    await sound.unlock();
    sound.schedule(1000, { now: () => 1000 + DEFAULT_END_SOUND.maxLatenessMs });
    expect(a.starts).toEqual([10]);

    const b = fakeAudio();
    const late = createEndSound({ createContext: () => b.ctx });
    await late.unlock();
    late.schedule(1000, { now: () => 1001 + DEFAULT_END_SOUND.maxLatenessMs });
    expect(b.osc.start).not.toHaveBeenCalled();

    const c = fakeAudio();
    const custom = createEndSound({
      createContext: () => c.ctx,
      settings: { ...DEFAULT_END_SOUND, maxLatenessMs: 60_000 },
    });
    await custom.unlock();
    custom.schedule(1000, { now: () => 31_000 });
    expect(c.osc.start).toHaveBeenCalledTimes(1);
  });
});

describe("end sound rescheduling", () => {
  it("moves the tone when the end time changes", async () => {
    const a = fakeAudio();
    const sound = createEndSound({ createContext: () => a.ctx });
    await sound.unlock();
    sound.schedule(60_000, { now: () => 0 });
    sound.schedule(90_000, { now: () => 0 });
    expect(a.osc.stop).toHaveBeenCalledWith(0);
    expect(a.osc.disconnect).toHaveBeenCalledTimes(1);
    expect(a.starts).toEqual([70, 100]);
  });

  it("moves the tone after a server resync, ignores small jitter", async () => {
    const a = fakeAudio();
    const sound = createEndSound({ createContext: () => a.ctx });
    await sound.unlock();
    sound.schedule(60_000, { now: () => 0 });
    sound.schedule(60_000, { now: () => 2000 });
    expect(a.starts).toEqual([70, 68]);
    sound.schedule(60_000, { now: () => 2050 });
    expect(a.starts).toEqual([70, 68]);
  });

  it("cancel before schedule is harmless and a cancelled tone never starts", async () => {
    const a = fakeAudio();
    const sound = createEndSound({ createContext: () => a.ctx });
    expect(() => sound.cancel()).not.toThrow();
    await sound.unlock();
    sound.cancel();
    expect(a.ctx.createOscillator).not.toHaveBeenCalled();
    sound.schedule(5000, { now: () => 0 });
    sound.cancel();
    expect(a.osc.stop).toHaveBeenLastCalledWith(0);
  });

  it("configure drops the tone and honours a disabled setting", async () => {
    const a = fakeAudio();
    const sound = createEndSound({ createContext: () => a.ctx });
    await sound.unlock();
    sound.schedule(5000, { now: () => 0 });
    sound.configure({ ...DEFAULT_END_SOUND, enabled: false });
    expect(a.osc.stop).toHaveBeenCalledWith(0);
    sound.schedule(9000, { now: () => 0 });
    expect(a.osc.start).toHaveBeenCalledTimes(1);
  });
});

describe("end sound settings storage", () => {
  const store = (raw: string | null) => ({ getItem: () => raw });

  it("falls back to defaults for missing storage, bad JSON and blocked access", () => {
    expect(loadEndSoundSettings(undefined)).toEqual(DEFAULT_END_SOUND);
    expect(loadEndSoundSettings(store(null))).toEqual(DEFAULT_END_SOUND);
    expect(loadEndSoundSettings(store("{not json"))).toEqual(DEFAULT_END_SOUND);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadEndSoundSettings(blocked)).toEqual(DEFAULT_END_SOUND);
  });

  it("rejects out-of-range values per field and keeps valid ones", () => {
    const raw = JSON.stringify({
      enabled: false,
      frequencyHz: END_SOUND_BOUNDS.frequencyHz.max + 1,
      durationMs: 0,
      volume: 2,
      maxLatenessMs: -1,
    });
    expect(loadEndSoundSettings(store(raw))).toEqual({ ...DEFAULT_END_SOUND, enabled: false });
    expect(loadEndSoundSettings(store(JSON.stringify({ frequencyHz: 523, volume: 0.2 })))).toEqual({
      ...DEFAULT_END_SOUND,
      frequencyHz: 523,
      volume: 0.2,
    });
  });

  it("saves under the storage key and ignores a failing storage", () => {
    const setItem = vi.fn();
    const next = { ...DEFAULT_END_SOUND, volume: 0.1 };
    saveEndSoundSettings({ setItem }, next);
    expect(setItem).toHaveBeenCalledWith(END_SOUND_STORAGE_KEY, JSON.stringify(next));
    const broken = {
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() => saveEndSoundSettings(broken, next)).not.toThrow();
  });
});
