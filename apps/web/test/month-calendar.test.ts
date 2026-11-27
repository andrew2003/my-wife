import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { MonthCalendarView } from "../components/month-calendar-view";
import { solarToLunar as serviceSolarToLunar } from "../../../services/schedule/src/lunar";
import { solarToLunar } from "../lib/lunar";
import { buildMonthGrid, shiftMonth } from "../lib/month-calendar";

describe("lunar conversion mirror", () => {
  it("matches the schedule service on sample dates", () => {
    for (const d of ["2024-02-10", "2023-03-22", "2025-07-25", "2026-11-27", "2100-12-31"]) {
      expect(solarToLunar(d)).toEqual(serviceSolarToLunar(d));
    }
  });
  it("knows Tet 2024 and a leap month", () => {
    expect(solarToLunar("2024-02-10")).toEqual({ year: 2024, month: 1, day: 1, leap: false });
    expect(solarToLunar("2023-03-22")).toMatchObject({ month: 2, day: 1, leap: true });
  });
});

describe("month grid", () => {
  it("lists every day of the month with a solar and a lunar date", () => {
    const grid = buildMonthGrid(2024, 2);
    const days = grid.flat().filter((c) => c !== null);
    expect(days).toHaveLength(29);
    const tet = days.find((c) => c.iso === "2024-02-10")!;
    expect(tet.solarDay).toBe(10);
    expect(tet.lunar).toEqual({ year: 2024, month: 1, day: 1, leap: false });
  });
  it("starts weeks on Monday and pads with empty cells", () => {
    const grid = buildMonthGrid(2024, 2); // 1 Feb 2024 is a Thursday
    expect(grid[0]!.slice(0, 3)).toEqual([null, null, null]);
    expect(grid[0]![3]!.iso).toBe("2024-02-01");
    expect(grid.every((w) => w.length === 7)).toBe(true);
  });
  it("leaves lunar empty outside the supported years", () => {
    const grid = buildMonthGrid(2101, 1);
    expect(grid.flat().find((c) => c)!.lunar).toBeNull();
  });
  it("shifts across years", () => {
    expect(shiftMonth(2024, 12, 1)).toEqual({ year: 2025, month: 1 });
    expect(shiftMonth(2024, 1, -1)).toEqual({ year: 2023, month: 12 });
  });
});

describe("month calendar view", () => {
  const noop = () => {};
  const base = {
    year: 2024,
    month: 2,
    today: "2024-02-10",
    onPrev: noop,
    onNext: noop,
    onToday: noop,
  };
  it("shows solar and lunar dates for each day, in Vietnamese", () => {
    const html = renderToStaticMarkup(
      createElement(MonthCalendarView, { ...base, locale: "vi", status: "ready" }),
    );
    expect(html).toContain(vi["calendar.legend"]);
    expect((html.match(/data-solar="/g) ?? []).length).toBe(29);
    expect((html.match(/data-lunar="/g) ?? []).length).toBe(29);
    expect(html).toContain('data-solar="10"');
    expect(html).toContain('data-lunar="1/1"');
    expect(html).toContain('aria-current="date"');
  });
  it("marks leap months and uses English strings", () => {
    const html = renderToStaticMarkup(
      createElement(MonthCalendarView, {
        ...base,
        year: 2023,
        month: 3,
        today: "2023-03-01",
        locale: "en",
        status: "ready",
      }),
    );
    expect(html).toContain('data-lunar="1/2L"');
    expect(html).toContain(en["calendar.legend"]);
  });
  it("has a loading state", () => {
    const html = renderToStaticMarkup(
      createElement(MonthCalendarView, { ...base, locale: "en", status: "loading" }),
    );
    expect(html).toContain(en["calendar.loading"]);
  });
  it("has locale keys in both languages", () => {
    for (const k of [
      "calendar.title",
      "calendar.loading",
      "calendar.prev",
      "calendar.next",
      "calendar.today",
      "calendar.lunar_unavailable",
      "nav.calendar",
    ]) {
      expect(en).toHaveProperty([k]);
      expect(vi).toHaveProperty([k]);
    }
  });
});
