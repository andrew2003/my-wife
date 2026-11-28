import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { BlockDetails, ScheduleView } from "../components/schedule-view";
import {
  blockStatus,
  describeRepeat,
  loadSchedule,
  type ScheduleData,
} from "../lib/schedule-screen";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const WEEK = {
  id: "11111111-1111-4111-8111-111111111111",
  firstDay: "2026-11-23",
  state: "active",
};
const REC_ID = "44444444-4444-4444-8444-444444444444";
const task = (over: Record<string, unknown>) => ({
  id: "22222222-2222-4222-8222-222222222222",
  title: "Write report",
  day: "2026-11-28",
  window: { start: "09:00", end: "10:30" },
  estimatedMinutes: 90,
  energyLevel: null,
  definitionOfDone: null,
  monitoringProfile: "camera",
  kind: "desk",
  state: "planned",
  carriedCount: 0,
  parentRecurrenceId: null,
  ...over,
});
const RECS = [
  { id: REC_ID, calendar: "solar", pattern: { type: "weekly", weekdays: [1, 3] }, exceptions: [] },
];

function fetcher(opts: { sync?: boolean; recurrences?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/weeks/current")) return json(200, { ok: true, data: { week: WEEK } });
    if (url.startsWith("/api/checklist")) {
      const date = new URL(url, "http://x").searchParams.get("date");
      const tasks =
        date === "2026-11-28"
          ? [
              task({}),
              task({
                id: "x",
                title: "Walk",
                state: "done",
                window: { start: "07:00", end: "07:30" },
              }),
            ]
          : [];
      return json(200, { ok: true, data: { date, tasks } });
    }
    if (url.startsWith("/api/recurrences"))
      return opts.recurrences === false
        ? json(404, { ok: false })
        : json(200, { ok: true, data: { recurrences: RECS } });
    if (url.startsWith("/api/sync/status"))
      return opts.sync === false
        ? json(404, { ok: false })
        : json(200, {
            ok: true,
            data: {
              links: [
                {
                  target: "calendar",
                  state: "ready",
                  lastSyncedAt: "2026-11-28T01:00:00.000Z",
                  maskTitles: false,
                },
              ],
            },
          });
    return json(404, { ok: false });
  });
}

describe("blockStatus", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["finished", { state: "done" }, "done"],
    ["running", { state: "in_progress" }, "current"],
    ["window ended and still planned", { window: { start: "07:00", end: "08:00" } }, "late"],
    ["window not started", { window: { start: "15:00", end: "16:00" } }, "upcoming"],
    ["inside its window", { window: { start: "09:00", end: "11:00" } }, "current"],
    ["planned on an earlier day", { day: "2026-11-27" }, "late"],
    ["planned on a later day", { day: "2026-11-29" }, "upcoming"],
    ["skipped", { state: "skipped" }, "closed"],
  ];
  it.each(cases)("%s", (_n, over, expected) => {
    expect(blockStatus(task(over) as never, "2026-11-28", "09:30")).toBe(expected);
  });
});

describe("describeRepeat", () => {
  it("returns null for a one-off block", () => {
    expect(describeRepeat(task({}) as never, RECS as never)).toBeNull();
  });
  it("describes the weekly pattern", () => {
    expect(describeRepeat(task({ parentRecurrenceId: REC_ID }) as never, RECS as never)).toEqual({
      key: "schedule.repeat.weekly",
      weekdays: [1, 3],
    });
  });
  it("falls back to a generic repeat when the pattern is unknown", () => {
    expect(describeRepeat(task({ parentRecurrenceId: "zzz" }) as never, [])).toEqual({
      key: "schedule.repeat.unknown",
    });
  });
});

describe("loadSchedule", () => {
  it("loads the week, the blocks of its seven days, repeats and sync", async () => {
    const res = await loadSchedule(fetcher());
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.data.week.id).toBe(WEEK.id);
    expect(res.data.tasks).toHaveLength(2);
    expect(res.data.recurrences).toHaveLength(1);
    expect(res.data.sync?.[0]?.target).toBe("calendar");
  });
  it("still shows blocks when repeats and sync are unavailable", async () => {
    const res = await loadSchedule(fetcher({ sync: false, recurrences: false }));
    expect(res.status).toBe("ready");
    if (res.status === "ready") {
      expect(res.data.sync).toBeNull();
      expect(res.data.recurrences).toEqual([]);
    }
  });
  it("is empty when there is no current week", async () => {
    const f = vi.fn(async () => json(404, { ok: false }));
    expect((await loadSchedule(f)).status).toBe("empty");
  });
  it("is an error when the server fails", async () => {
    const f = vi.fn(async () => json(500, { ok: false }));
    expect((await loadSchedule(f)).status).toBe("error");
  });
});

async function data(): Promise<ScheduleData> {
  const res = await loadSchedule(fetcher());
  if (res.status !== "ready") throw new Error("not ready");
  return res.data;
}
const noop = () => undefined;
const view = (over: Record<string, unknown>, locale: "en" | "vi" = "en") =>
  createElement(ScheduleView, {
    locale,
    status: "ready",
    data: null,
    today: "2026-11-28",
    nowHm: "09:30",
    day: "2026-11-28",
    tab: "today",
    detailId: null,
    onTab: noop,
    onDay: noop,
    onDetails: noop,
    onCloseDetails: noop,
    onRetry: noop,
    panels: { week: "WEEKPANEL", calendar: "CALPANEL", review: "REVIEWPANEL" },
    ...over,
  } as never);

describe("ScheduleView", () => {
  it("shows the four tabs, the week strip, blocks and a details button per block", async () => {
    const html = renderToStaticMarkup(view({ data: await data() }));
    for (const k of ["today", "week", "calendar", "review"]) {
      expect(html).toContain(en[`schedule.tab.${k}` as keyof typeof en]);
    }
    expect(html).toContain("Write report");
    expect(html).toContain("Walk");
    expect(html).toContain(en["schedule.status.current"]);
    expect(html).toContain(en["schedule.status.done"]);
    expect((html.match(/data-details/g) ?? []).length).toBe(2);
    expect((html.match(/data-day=/g) ?? []).length).toBe(7);
  });
  it("renders the week, calendar and review panels on their tabs", async () => {
    const d = await data();
    expect(renderToStaticMarkup(view({ data: d, tab: "week" }))).toContain("WEEKPANEL");
    expect(renderToStaticMarkup(view({ data: d, tab: "calendar" }))).toContain("CALPANEL");
    expect(renderToStaticMarkup(view({ data: d, tab: "review" }))).toContain("REVIEWPANEL");
  });
  it("has loading, empty and error states", () => {
    expect(renderToStaticMarkup(view({ status: "loading" }))).toContain(en["schedule.loading"]);
    expect(renderToStaticMarkup(view({ status: "empty" }))).toContain(en["schedule.empty"]);
    const err = renderToStaticMarkup(view({ status: "error" }));
    expect(err).toContain('role="alert"');
    expect(err).toContain(en["schedule.retry"]);
  });
  it("shows an empty day message", async () => {
    const html = renderToStaticMarkup(view({ data: await data(), day: "2026-11-25" }));
    expect(html).toContain(en["schedule.day_empty"]);
  });
  it("renders Vietnamese text from the locale file", async () => {
    const html = renderToStaticMarkup(view({ data: await data() }, "vi"));
    expect(html).toContain(vi_["schedule.tab.review"]);
  });
});

describe("BlockDetails", () => {
  it("shows time, repeat, monitoring, sync per calendar, edit and open in calendar", async () => {
    const d = await data();
    const html = renderToStaticMarkup(
      createElement(BlockDetails, {
        locale: "en",
        task: task({ parentRecurrenceId: REC_ID }) as never,
        recurrences: d.recurrences,
        sync: d.sync,
      }),
    );
    expect(html).toContain("09:00");
    expect(html).toContain("10:30");
    expect(html).toContain(en["schedule.monitoring.camera"]);
    expect(html).toContain(en["schedule.sync.state.ready"]);
    expect(html).toContain(en["schedule.details.edit"]);
    expect(html).toContain('href="/schedule/calendar?day=2026-11-28"');
    expect(html).toContain("Weekly");
  });
  it("says sync is unknown when the status is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(BlockDetails, {
        locale: "en",
        task: task({}) as never,
        recurrences: [],
        sync: null,
      }),
    );
    expect(html).toContain(en["schedule.sync.unknown"]);
    expect(html).toContain(en["schedule.repeat.none"]);
  });
});

describe("locale files and layout", () => {
  it("vi and en define the same schedule keys", () => {
    const keys = (o: object) =>
      Object.keys(o)
        .filter((k) => k.startsWith("schedule."))
        .sort();
    expect(keys(vi_)).toEqual(keys(en));
    expect(keys(en).length).toBeGreaterThan(20);
  });
  it("keeps the 360 px layout from scrolling sideways", () => {
    const css = readFileSync(new URL("../app/schedule.css", import.meta.url), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`))?.[0] ?? "";
    expect(rule(".schedule-strip")).toContain("minmax(0, 1fr)");
    expect(rule(".schedule-block")).toContain("overflow-wrap");
    expect(rule(".schedule-root")).toContain("min-width: 0");
    const html = renderToStaticMarkup(view({ data: null, status: "loading" }));
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });
});
