import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as vitest } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { TourView } from "../components/tour-view";
import { TOUR_STEPS, completeTour, loadTourState } from "../lib/tour";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("tour steps", () => {
  it("covers schedule, budget, inbox and settings with locale keys in both locales", () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(["schedule", "budget", "inbox", "settings"]);
    for (const s of TOUR_STEPS) {
      for (const k of [s.titleKey, s.bodyKey]) {
        expect(vi).toHaveProperty([k]);
        expect(en).toHaveProperty([k]);
      }
    }
  });
});

describe("TourView", () => {
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TourView, {
        locale: "vi",
        index: 0,
        busy: false,
        errorKey: null,
        onNext: () => {},
        onSkip: () => {},
        ...props,
      } as never),
    );

  it("shows every step and Skip is available on each one", () => {
    TOUR_STEPS.forEach((s, i) => {
      const html = view({ index: i });
      expect(html).toContain((vi as Record<string, string>)[s.titleKey]);
      expect(html).toContain(vi["tour.skip"]);
    });
  });

  it("offers Next before the last step and Done on the last", () => {
    expect(view({ index: 0 })).toContain(vi["tour.next"]);
    const last = view({ index: TOUR_STEPS.length - 1 });
    expect(last).toContain(vi["tour.finish"]);
    expect(last).not.toContain(`>${vi["tour.next"]}<`);
  });

  it("shows an error and renders English", () => {
    expect(view({ errorKey: "tour.error" })).toContain(vi["tour.error"]);
    expect(view({ locale: "en" })).toContain(en["tour.skip"]);
  });
});

describe("loadTourState", () => {
  it("is pending when the tour was not completed", async () => {
    const f = vitest.fn(async (_u: string) =>
      json(200, { ok: true, data: { step: "tour", completed: false, skipped: false } }),
    );
    expect(await loadTourState(f as never)).toBe("pending");
    expect(f.mock.calls[0]![0]).toBe("/api/onboarding/steps/tour");
  });

  it("is done when completed or skipped", async () => {
    const f = async () =>
      json(200, { ok: true, data: { step: "tour", completed: true, skipped: true } });
    expect(await loadTourState(f as never)).toBe("done");
  });

  it("never shows the tour when the state is unknown", async () => {
    expect(await loadTourState((async () => json(502, {})) as never)).toBe("unknown");
    const down = async () => {
      throw new Error("down");
    };
    expect(await loadTourState(down as never)).toBe("unknown");
  });
});

describe("completeTour", () => {
  it("posts onboarding step tour with skipped true on skip", async () => {
    const f = vitest.fn(async (_u: string, _i: RequestInit) =>
      json(200, { ok: true, data: { step: "tour", skipped: true } }),
    );
    expect(await completeTour(true, f as never)).toBe(true);
    expect(f.mock.calls[0]![0]).toBe("/api/onboarding/steps");
    expect(f.mock.calls[0]![1].method).toBe("POST");
    expect(JSON.parse(String(f.mock.calls[0]![1].body))).toEqual({ step: "tour", skipped: true });
  });

  it("posts skipped false on finish and reports failure", async () => {
    const f = vitest.fn(async (_u: string, _i: RequestInit) => json(503, { ok: false }));
    expect(await completeTour(false, f as never)).toBe(false);
    expect(JSON.parse(String(f.mock.calls[0]![1].body))).toEqual({ step: "tour", skipped: false });
  });
});
