import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { RoutinesView } from "../components/routines-view";
import { SleepView } from "../components/sleep-view";
import { NAV_ITEMS } from "../lib/nav";
import { readFileSync } from "node:fs";
import {
  isLoosening,
  loadRoutines,
  loadRoutineWeek,
  saveRoutineSetting,
  type RoutinesData,
} from "../lib/routines";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("loadRoutines", () => {
  it("reads levels and sleep settings, filling registry defaults", async () => {
    const f = (async () =>
      json(200, {
        ok: true,
        data: { values: { "routine.wake.level": "commit", "routine.wake_grace_minutes": 20 } },
      })) as never;
    const res = await loadRoutines(f);
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.data.levels).toEqual({ sleep: "track", wake: "commit", meals: "track" });
    expect(res.data.sleep["routine.wake_grace_minutes"]).toBe(20);
    expect(res.data.sleep["routine.sleep.start"]).toBe("23:00");
    expect(res.data.sleep["routine.wake_second_check_minutes"]).toBe(0);
  });

  it("is empty when every routine is off and errors on a failed read", async () => {
    const off = (async () =>
      json(200, {
        ok: true,
        data: {
          values: {
            "routine.sleep.level": "off",
            "routine.wake.level": "off",
            "routine.meals.level": "off",
          },
        },
      })) as never;
    expect((await loadRoutines(off)).status).toBe("empty");
    expect((await loadRoutines((async () => json(500, { ok: false })) as never)).status).toBe(
      "error",
    );
  });
});

describe("saveRoutineSetting", () => {
  it("puts one key and returns the direction and effective time", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, JSON.parse(String(init?.body))]);
      return json(200, {
        ok: true,
        data: {
          key: "routine.wake.level",
          direction: "loosening",
          effectiveFrom: "2026-12-07T17:00:00.000Z",
        },
      });
    }) as never;
    const res = await saveRoutineSetting("routine.wake.level", "remind", f);
    expect(res).toEqual({
      ok: true,
      direction: "loosening",
      effectiveFrom: "2026-12-07T17:00:00.000Z",
    });
    expect(calls).toEqual([
      ["/api/settings", "PUT", { key: "routine.wake.level", value: "remind" }],
    ]);
    const failing = (async () => json(500, {})) as never;
    expect(await saveRoutineSetting("routine.wake.level", "off", failing)).toEqual({ ok: false });
  });
});

describe("isLoosening", () => {
  it("treats lowering a level as loosening", () => {
    expect(isLoosening("commit", "track")).toBe(true);
    expect(isLoosening("track", "off")).toBe(true);
    expect(isLoosening("remind", "commit")).toBe(false);
    expect(isLoosening("track", "track")).toBe(false);
  });
});

const data: RoutinesData = {
  levels: { sleep: "track", wake: "commit", meals: "track" },
  sleep: {
    "routine.sleep.start": "23:00",
    "routine.wake.time": "06:00",
    "routine.winddown_lead_minutes": 60,
    "routine.bedtime_lead_minutes": 15,
    "routine.wake_nudge_interval_minutes": 5,
    "routine.wake_nudge_max": 6,
    "routine.wake_grace_minutes": 15,
    "routine.wake_photo_window_minutes": 10,
    "routine.wake_second_check_minutes": 0,
  },
};

const base = {
  locale: "en",
  status: "ready",
  data,
  saveState: "idle",
  notice: null,
  timeZone: "Asia/Ho_Chi_Minh",
  week: [
    "2026-11-23",
    "2026-11-24",
    "2026-11-25",
    "2026-11-26",
    "2026-11-27",
    "2026-11-28",
    "2026-11-29",
  ],
  wake: { status: "recorded", wakeTime: "2026-11-28T23:05:00.000Z", minutesLate: 5 },
  onChange: () => {},
  onRefresh: () => {},
};
const render = (c: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(c as never, { ...base, ...props } as never));

describe("RoutinesView", () => {
  it("lists one editable card per routine with the four-level control", () => {
    const html = render(RoutinesView, {});
    expect(html).toContain(en["routines.loosening"]);
    expect(html.match(/class="mw-card routine-card"/g)).toHaveLength(3);
    expect(html.match(/class="mw-segmented"/g)).toHaveLength(3);
    expect(html.match(/class="mw-segmented-item"/g)).toHaveLength(12);
    expect(html).toContain(en["routines.routine.wake"]);
    expect(html).toContain(en["routines.level.commit.help"]);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Commit/);
  });

  it("shows a week strip of seven days in every card and the wake banner", () => {
    const html = render(RoutinesView, {});
    expect(html.match(/class="routine-strip-day"/g)).toHaveLength(21);
    expect(html).toContain(en["routines.week.unknown"]);
    expect(html).toContain("routines-banner");
    const none = render(RoutinesView, { wake: { status: "none" }, week: null });
    expect(none).not.toContain("routines-banner");
    expect(none).not.toContain("routine-strip-day");
  });

  it("keeps the 360 px layout from scrolling sideways", () => {
    const css = readFileSync(new URL("../app/routines.css", import.meta.url), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`))?.[0] ?? "";
    expect(rule(".routine-strip")).toContain("minmax(0, 1fr)");
    expect(rule(".routine-card")).toContain("min-width: 0");
    expect(rule(".routines")).toContain("max-width: 100%");
    expect(render(RoutinesView, {})).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });

  it("shows when a loosening change takes effect", () => {
    const html = render(RoutinesView, {
      notice: {
        key: "routine.wake.level",
        direction: "loosening",
        effectiveFrom: "2026-12-07T17:00:00.000Z",
      },
    });
    expect(html).toContain("Dec 8, 2026");
  });

  it("has loading, empty, error and failed-save states", () => {
    expect(render(RoutinesView, { status: "loading" })).toContain(en["routines.loading"]);
    expect(render(RoutinesView, { status: "empty" })).toContain(en["routines.empty"]);
    expect(render(RoutinesView, { status: "error", locale: "vi" })).toContain(vi["routines.error"]);
    expect(render(RoutinesView, { saveState: "failed" })).toContain(en["routines.error.save"]);
  });
});

describe("SleepView", () => {
  it("shows every sleep and wake-up setting as an editable field", () => {
    const html = render(SleepView, {});
    expect(html.match(/<input/g)).toHaveLength(9);
    expect(html).toContain('value="23:00"');
    expect(html).toContain(en["sleep.field.routine.wake_grace_minutes"]);
    expect(html).toContain(en["sleep.second_check_off"]);
  });

  it("has loading, empty and error states", () => {
    expect(render(SleepView, { status: "loading" })).toContain(en["routines.loading"]);
    expect(render(SleepView, { status: "empty" })).toContain(en["routines.empty"]);
    expect(render(SleepView, { status: "error" })).toContain(en["routines.error"]);
  });
});

describe("locales and nav", () => {
  it("has every routines and sleep key in both locales", () => {
    const keys = Object.keys(en).filter(
      (k) => /^(routines|sleep)\./.test(k) || k.startsWith("nav.routines"),
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(vi).toHaveProperty([k]);
    expect(NAV_ITEMS.some((n) => n.href === "/routines")).toBe(true);
    expect(NAV_ITEMS.some((n) => n.href === "/routines/sleep")).toBe(true);
  });
});

describe("loadRoutineWeek", () => {
  it("returns the seven days of the current week, or null when unknown", async () => {
    const ok = (async () =>
      json(200, {
        ok: true,
        data: { week: { id: "w1", firstDay: "2026-11-23", state: "active" } },
      })) as never;
    const days = await loadRoutineWeek(ok);
    expect(days).toHaveLength(7);
    expect(days?.[0]).toBe("2026-11-23");
    expect(await loadRoutineWeek((async () => json(404, {})) as never)).toBeNull();
    expect(
      await loadRoutineWeek((async () => {
        throw new Error("down");
      }) as never),
    ).toBeNull();
  });

  it("has the new routine keys in both locales", () => {
    const keys = (c: Record<string, string>) =>
      Object.keys(c).filter((k) => k.startsWith("routines."));
    expect(keys(vi)).toEqual(keys(en));
    for (const k of ["routines.week.unknown", "routines.note.wake", "routines.banner.title"]) {
      expect(en).toHaveProperty([k]);
      expect(vi).toHaveProperty([k]);
    }
  });
});
