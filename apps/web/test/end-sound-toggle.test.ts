import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Same tiny hook runtime as pip-toggle.test.ts: no DOM, so hooks are replaced. */
const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  effects: [] as {
    deps?: unknown[];
    fn: () => void | (() => void);
    cleanup?: void | (() => void);
  }[],
  cursor: 0,
  effectCursor: 0,
  render: () => {},
  pending: [] as number[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = rt.cursor++;
      if (!(i in rt.slots)) rt.slots[i] = init;
      return [
        rt.slots[i],
        (v: unknown) => {
          rt.slots[i] = v;
          rt.render();
        },
      ];
    },
    useRef: (init: unknown) => {
      const i = rt.cursor++;
      if (!(i in rt.slots)) rt.slots[i] = { current: init };
      return rt.slots[i];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = rt.effectCursor++;
      const prev = rt.effects[i];
      const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps![k]);
      if (changed) {
        rt.effects[i] = { deps, fn, cleanup: prev?.cleanup };
        rt.pending.push(i);
      }
    },
  };
});

import { EndSoundToggle } from "../components/session-countdown";
import { DEFAULT_END_SOUND, END_SOUND_STORAGE_KEY } from "../lib/end-sound";

type El = { type: unknown; props: { children?: unknown; [k: string]: unknown } };

function collect(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    collect((node as El).props.children, out);
  }
  return out;
}

function mount(props: { endsAtMs: number; serverOffsetMs?: number; clock?: { now(): number } }) {
  let current: unknown;
  const run = () => {
    rt.cursor = 0;
    rt.effectCursor = 0;
    current = EndSoundToggle({ locale: "en", ...props });
    for (const i of rt.pending.splice(0)) {
      const e = rt.effects[i]!;
      if (typeof e.cleanup === "function") e.cleanup();
      e.cleanup = e.fn();
    }
  };
  rt.render = run;
  run();
  return {
    els: () => collect(current),
    byClass: (c: string) => collect(current).find((e) => e.props.className === c),
    unmount() {
      for (const e of rt.effects) if (typeof e.cleanup === "function") e.cleanup();
    },
  };
}

function setup(saved?: object) {
  const storage = new Map<string, string>();
  if (saved) storage.set(END_SOUND_STORAGE_KEY, JSON.stringify({ ...DEFAULT_END_SOUND, ...saved }));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  const starts: number[] = [];
  const osc = {
    type: "",
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn((t: number) => void starts.push(t)),
    stop: vi.fn(),
    disconnect: vi.fn(),
  };
  class FakeAudioContext {
    state = "suspended";
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => void (this.state = "running"));
    createOscillator = () => osc;
    createGain = () => ({ gain: { value: 0 }, connect: vi.fn() });
  }
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  return { storage, starts, osc };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("EndSoundToggle", () => {
  beforeEach(() => {
    rt.slots = [];
    rt.effects = [];
    rt.pending.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("schedules the sound after the unlock click, using the server offset", async () => {
    const { starts } = setup();
    const m = mount({ endsAtMs: 100_000, serverOffsetMs: 5000, clock: { now: () => 40_000 } });
    expect(starts).toEqual([]);
    const unlock = m.byClass("sound-unlock")!;
    (unlock.props.onClick as () => void)();
    await flush();
    // end 100s, client now 40s, offset +5s => 55s away
    expect(starts).toEqual([55]);
    expect(m.byClass("sound-on")).toBeDefined();
    m.unmount();
  });

  it("stays rendered when disabled and can be switched on again", async () => {
    const { storage, starts } = setup({ enabled: false });
    const m = mount({ endsAtMs: 10_000, clock: { now: () => 0 } });
    const box = m.els().find((e) => e.props.type === "checkbox")!;
    expect(box.props.checked).toBe(false);
    expect(m.byClass("sound-unlock")).toBeUndefined();
    (box.props.onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    await flush();
    expect(JSON.parse(storage.get(END_SOUND_STORAGE_KEY)!).enabled).toBe(true);
    expect(starts).toEqual([10]);
    m.unmount();
  });

  it("saves a changed setting", () => {
    const { storage } = setup();
    const m = mount({ endsAtMs: 10_000, clock: { now: () => 0 } });
    const freq = m.els().find((e) => e.props.name === "frequencyHz")!;
    (freq.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "440" },
    });
    expect(JSON.parse(storage.get(END_SOUND_STORAGE_KEY)!).frequencyHz).toBe(440);
    (freq.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "999999" },
    });
    expect(JSON.parse(storage.get(END_SOUND_STORAGE_KEY)!).frequencyHz).toBe(440);
    m.unmount();
  });
});
