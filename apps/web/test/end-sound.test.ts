import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import {
  DEFAULT_END_SOUND,
  createEndSound,
  type AudioContextLike,
  type EndSoundSettings,
} from "../lib/end-sound";

function fakeAudio(state: "suspended" | "running" = "suspended") {
  const starts: number[] = [];
  const stops: number[] = [];
  const osc = {
    type: "sine",
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn((t: number) => void starts.push(t)),
    stop: vi.fn((t: number) => void stops.push(t)),
    disconnect: vi.fn(),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  const ctx: AudioContextLike = {
    state,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => {
      ctx.state = "running";
    }),
    createOscillator: vi.fn(() => osc),
    createGain: vi.fn(() => gain),
  };
  return { ctx, osc, gain, starts, stops };
}

describe("end-of-task sound", () => {
  it("plays once at the end time, scheduled on the audio clock", async () => {
    const a = fakeAudio();
    const sound = createEndSound({ createContext: () => a.ctx });
    await sound.unlock();
    expect(a.ctx.resume).toHaveBeenCalled();
    const clock = { now: () => 1_000_000 };
    sound.schedule(1_000_000 + 90_000, clock);
    sound.schedule(1_000_000 + 90_000, clock);
    expect(a.starts).toEqual([100]);
    expect(a.osc.start).toHaveBeenCalledTimes(1);
  });

  it("uses the user settings for tone and volume", async () => {
    const a = fakeAudio();
    const settings: EndSoundSettings = {
      enabled: true,
      frequencyHz: 440,
      durationMs: 2000,
      volume: 0.3,
    };
    const sound = createEndSound({ createContext: () => a.ctx, settings });
    await sound.unlock();
    sound.schedule(5_000, { now: () => 0 });
    expect(a.osc.frequency.value).toBe(440);
    expect(a.gain.gain.value).toBe(0.3);
    expect(a.stops).toEqual([10 + 5 + 2]);
  });

  it("stays silent when disabled or when audio was never unlocked", async () => {
    const a = fakeAudio();
    const off = createEndSound({
      createContext: () => a.ctx,
      settings: { ...DEFAULT_END_SOUND, enabled: false },
    });
    await off.unlock();
    off.schedule(1000, { now: () => 0 });
    createEndSound({ createContext: () => a.ctx }).schedule(1000, { now: () => 0 });
    expect(a.osc.start).not.toHaveBeenCalled();
  });

  it("cancel prevents the sound", async () => {
    const a = fakeAudio();
    const sound = createEndSound({ createContext: () => a.ctx });
    await sound.unlock();
    sound.schedule(5000, { now: () => 0 });
    sound.cancel();
    expect(a.osc.stop).toHaveBeenCalledWith(0);
    expect(a.osc.disconnect).toHaveBeenCalled();
  });

  it("plays at once when the end time has already passed (hidden tab resumed)", async () => {
    const a = fakeAudio("running");
    const sound = createEndSound({ createContext: () => a.ctx });
    await sound.unlock();
    sound.schedule(1000, { now: () => 5000 });
    expect(a.starts).toEqual([10]);
  });

  it("has locale strings in vi and en", () => {
    for (const k of ["sound.enable", "sound.enabled"]) {
      expect((en as Record<string, string>)[k]).toBeTruthy();
      expect((vi_ as Record<string, string>)[k]).toBeTruthy();
    }
  });
});
