import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The test environment has no DOM, so React hooks are replaced by a tiny runtime that
 * re-renders the real PipToggle function on state changes and runs effects after render.
 */
const rt = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    effects: [] as {
      deps?: unknown[];
      fn: () => void | (() => void);
      cleanup?: void | (() => void);
    }[],
    cursor: 0,
    effectCursor: 0,
    render: () => {},
  };
  return state;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = rt.cursor++;
      if (!(i in rt.slots)) rt.slots[i] = init;
      const set = (v: unknown) => {
        rt.slots[i] = v;
        rt.render();
      };
      return [rt.slots[i], set];
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
      if (changed) rt.effects[i] = { deps, fn, cleanup: prev?.cleanup };
      if (changed) pending.push(i);
    },
  };
});

const pending: number[] = [];

import { PipToggle } from "../components/session-countdown";
import type { PipWindowLike } from "../lib/pip";

type ButtonEl = { type: string; props: { onClick?: () => void; children?: unknown } };

function mount(props: { text: string }) {
  let current: unknown;
  const run = () => {
    rt.cursor = 0;
    rt.effectCursor = 0;
    current = PipToggle({ locale: "en", text: props.text });
    for (const i of pending.splice(0)) {
      const e = rt.effects[i]!;
      if (typeof e.cleanup === "function") e.cleanup();
      e.cleanup = e.fn();
    }
  };
  rt.render = run;
  run();
  return {
    el: () => current as ButtonEl | null,
    setText(t: string) {
      props.text = t;
      run();
    },
    unmount() {
      for (const e of rt.effects) if (typeof e.cleanup === "function") e.cleanup();
    },
  };
}

function fakePip() {
  let onHide: () => void = () => {};
  const body = { textContent: "" };
  const win: PipWindowLike = {
    document: { body, title: "" },
    addEventListener: (_t, fn) => void (onHide = fn),
    close: () => onHide(),
  };
  const requestWindow = vi.fn(async () => win);
  return { body, requestWindow, hide: () => onHide() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PipToggle", () => {
  beforeEach(() => {
    rt.slots = [];
    rt.effects = [];
    pending.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing before support is known, then the open button", () => {
    const pip = fakePip();
    vi.stubGlobal("window", { documentPictureInPicture: pip });
    const m = mount({ text: "10:00" });
    expect(m.el()?.props.children).toBe("Open floating timer");
  });

  it("shows the unsupported hint without the API", () => {
    vi.stubGlobal("window", {});
    const m = mount({ text: "10:00" });
    expect(m.el()?.type).toBe("span");
  });

  it("opens with the current text, follows text changes and resets on pagehide", async () => {
    const pip = fakePip();
    vi.stubGlobal("window", { documentPictureInPicture: pip });
    const m = mount({ text: "10:00" });
    m.el()!.props.onClick!();
    await flush();
    expect(pip.body.textContent).toBe("10:00");
    expect(m.el()!.props.children).toBe("Close floating timer");
    m.setText("09:59");
    expect(pip.body.textContent).toBe("09:59");
    pip.hide();
    expect(m.el()!.props.children).toBe("Open floating timer");
  });

  it("opens only one window on a double click", async () => {
    const pip = fakePip();
    vi.stubGlobal("window", { documentPictureInPicture: pip });
    const m = mount({ text: "10:00" });
    const click = m.el()!.props.onClick!;
    click();
    click();
    await flush();
    expect(pip.requestWindow).toHaveBeenCalledTimes(1);
  });
});
