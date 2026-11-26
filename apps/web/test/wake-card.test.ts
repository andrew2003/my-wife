import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as vitest } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { WakeCardView } from "../components/wake-card-view";
import { loadWakeToday } from "../lib/wake";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const passed = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  state: "graded",
  grade: "pass",
  wakeAt: "2026-11-27T00:00:00.000Z",
  wakeTime: "2026-11-27T00:10:00.000Z",
  minutesLate: 10,
};

describe("loadWakeToday", () => {
  it("returns the recorded wake", async () => {
    const f = vitest.fn(async (_u: string) => json(200, { ok: true, data: { wake: passed } }));
    const res = await loadWakeToday(f as never);
    expect(f.mock.calls[0]![0]).toBe("/api/wake/today");
    expect(res).toEqual({ status: "recorded", wakeTime: passed.wakeTime, minutesLate: 10 });
  });

  it("is none when nothing is recorded today", async () => {
    const open = { ...passed, state: "sent", grade: null, wakeTime: null, minutesLate: null };
    const noWake = (async () => json(200, { ok: true, data: { wake: null } })) as never;
    const noTime = (async () => json(200, { ok: true, data: { wake: open } })) as never;
    expect(await loadWakeToday(noWake)).toEqual({ status: "none" });
    expect(await loadWakeToday(noTime)).toEqual({ status: "none" });
  });

  it("is none on failure so no card is shown", async () => {
    expect(await loadWakeToday((async () => json(404, {})) as never)).toEqual({ status: "none" });
    const boom = (async () => {
      throw new Error("network");
    }) as never;
    expect(await loadWakeToday(boom)).toEqual({ status: "none" });
  });
});

describe("WakeCardView", () => {
  const render = (
    locale: "vi" | "en",
    state: Parameters<typeof WakeCardView>[0]["state"],
  ): string =>
    renderToStaticMarkup(createElement(WakeCardView, { locale, state, timeZone: "UTC" }));

  it("shows the time and on time", () => {
    const html = render("en", { status: "recorded", wakeTime: passed.wakeTime, minutesLate: 0 });
    expect(html).toContain("00:10");
    expect(html).toContain(en["wake.on_time"]);
  });

  it("shows late with minutes", () => {
    const html = render("vi", { status: "recorded", wakeTime: passed.wakeTime, minutesLate: 10 });
    expect(html).toContain(vi["wake.late"].replace("{minutes}", "10"));
  });

  it("renders nothing without a recorded wake", () => {
    expect(render("en", { status: "none" })).toBe("");
    expect(render("en", { status: "loading" })).toBe("");
  });
});
