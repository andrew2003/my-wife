import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { SessionCountdownView } from "../components/session-countdown";
import { createCountdown, formatRemaining, remainingSeconds, type Ticker } from "../lib/countdown";

const END = Date.parse("2026-11-26T08:50:00.000Z");

function fake(startMs: number) {
  let now = startMs;
  let cb: (() => void) | null = null;
  let stopped = false;
  const ticker: Ticker = (fn) => {
    cb = fn;
    return () => void (stopped = true);
  };
  return {
    clock: { now: () => now },
    ticker,
    advance(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        now += 1000;
        cb?.();
      }
    },
    jump(ms: number) {
      now += ms;
      cb?.();
    },
    isStopped: () => stopped,
  };
}

describe("remainingSeconds", () => {
  it("is end minus now, rounded up, never negative", () => {
    expect(remainingSeconds(END, END - 90_500)).toBe(91);
    expect(remainingSeconds(END, END)).toBe(0);
    expect(remainingSeconds(END, END + 5000)).toBe(0);
  });
  it("formats mm:ss and h:mm:ss", () => {
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(125)).toBe("02:05");
    expect(formatRemaining(3725)).toBe("1:02:05");
  });
});

describe("createCountdown", () => {
  it("shows the remaining time from the stored end time on the first render", () => {
    const f = fake(END - 600_000);
    const seen: number[] = [];
    createCountdown({ endsAtMs: END, clock: f.clock, ticker: f.ticker, onTick: (s) => seen.push(s) });
    expect(seen).toEqual([600]);
  });

  it("with a fake clock, advancing N seconds shows remaining minus N", () => {
    const f = fake(END - 600_000);
    const seen: number[] = [];
    createCountdown({ endsAtMs: END, clock: f.clock, ticker: f.ticker, onTick: (s) => seen.push(s) });
    f.advance(7);
    expect(seen.at(-1)).toBe(593);
  });

  it("is correct after a reload mid-session and after a run of missed ticks", () => {
    const f = fake(END - 120_000);
    const seen: number[] = [];
    createCountdown({ endsAtMs: END, clock: f.clock, ticker: f.ticker, onTick: (s) => seen.push(s) });
    expect(seen[0]).toBe(120);
    f.jump(45_000);
    expect(seen.at(-1)).toBe(75);
  });

  it("corrects the client clock with the server offset", () => {
    const f = fake(END - 600_000 + 30_000);
    const seen: number[] = [];
    createCountdown({
      endsAtMs: END,
      clock: f.clock,
      ticker: f.ticker,
      serverOffsetMs: -30_000,
      onTick: (s) => seen.push(s),
    });
    expect(seen[0]).toBe(600);
  });

  it("reports the end once and stops the ticker", () => {
    const f = fake(END - 2000);
    let ended = 0;
    const c = createCountdown({
      endsAtMs: END,
      clock: f.clock,
      ticker: f.ticker,
      onTick: () => {},
      onEnd: () => void ended++,
    });
    f.advance(5);
    expect(ended).toBe(1);
    expect(f.isStopped()).toBe(true);
    c.stop();
  });
});

describe("SessionCountdownView", () => {
  it("renders the time and a localized label in both locales", () => {
    const html = renderToStaticMarkup(
      createElement(SessionCountdownView, { locale: "en", remaining: 125 }),
    );
    expect(html).toContain("02:05");
    expect(html).toContain(en["countdown.label"]);
    expect(vi["countdown.label"]).toBeTruthy();
  });
});
