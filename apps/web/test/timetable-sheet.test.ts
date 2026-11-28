import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { TimetableSheetView } from "../components/timetable-sheet-view";
import { cellValue, loadSheet, saveCell, type Sheet } from "../lib/timetable-sheet";
import { areaForRoute } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TASK_ID = "22222222-2222-4222-8222-222222222222";
const SHEET: Sheet = {
  week: { id: "11111111-1111-4111-8111-111111111111", firstDay: "2026-11-23", state: "active" },
  readOnly: false,
  rows: [
    {
      entityId: TASK_ID,
      cells: [
        { field: "title", value: "Write report", editable: true },
        { field: "day", value: "2026-11-24", editable: true },
        { field: "windowStart", value: "09:00", editable: true },
        { field: "windowEnd", value: "10:00", editable: true },
        { field: "estimatedMinutes", value: 60, editable: true },
        { field: "definitionOfDone", value: null, editable: true },
        { field: "state", value: "planned", editable: false },
        { field: "carriedCount", value: 0, editable: false },
      ],
    },
  ],
  computed: { plannedMinutes: 60 },
};

describe("loadSheet", () => {
  it("returns the sheet and asks for the given week", async () => {
    const doFetch = vi.fn(async (_u: string) => json(200, { ok: true, data: SHEET }));
    const res = await loadSheet(SHEET.week.id, doFetch);
    expect(res.status).toBe("ready");
    expect(doFetch.mock.calls[0]![0]).toBe(`/api/timetable-sheet?weekId=${SHEET.week.id}`);
  });
  it("is empty when there are no rows or no week", async () => {
    expect((await loadSheet(undefined, async () => json(404, {}))).status).toBe("empty");
    const none = { ...SHEET, rows: [] };
    expect(
      (await loadSheet(undefined, async () => json(200, { ok: true, data: none }))).status,
    ).toBe("empty");
  });
  it("is error on failure or bad body", async () => {
    expect((await loadSheet(undefined, async () => json(500, {}))).status).toBe("error");
    expect((await loadSheet(undefined, async () => json(200, { ok: true, data: {} }))).status).toBe(
      "error",
    );
    expect(
      (
        await loadSheet(undefined, async () => {
          throw new Error("x");
        })
      ).status,
    ).toBe("error");
  });
});

describe("cellValue", () => {
  it("converts the typed text to the field type", () => {
    expect(cellValue("estimatedMinutes", "45")).toBe(45);
    expect(cellValue("estimatedMinutes", "abc")).toBeNaN();
    expect(cellValue("title", "Hi")).toBe("Hi");
    expect(cellValue("definitionOfDone", "")).toBe("");
  });
});

describe("saveCell", () => {
  it("posts one timetable cell edit", async () => {
    const doFetch = vi.fn(async (_u: string, _i?: RequestInit) =>
      json(200, { ok: true, data: { status: "applied" } }),
    );
    const res = await saveCell(TASK_ID, "title", "New", doFetch);
    expect(res).toEqual({ ok: true });
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe("/api/timetable-sheet/cells");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      sheet: "timetable",
      entityId: TASK_ID,
      field: "title",
      value: "New",
    });
  });
  it("maps a rejection to a locale key", async () => {
    const res = await saveCell(TASK_ID, "title", "", async () =>
      json(200, { ok: true, data: { status: "rejected", reason: "validation_failed" } }),
    );
    expect(res).toEqual({ ok: false, errorKey: "sheet.reject.validation_failed" });
  });
  it("maps a network failure to a generic key", async () => {
    const res = await saveCell(TASK_ID, "title", "x", async () => json(500, {}));
    expect(res).toEqual({ ok: false, errorKey: "sheet.error.save" });
  });
});

const base = {
  status: "ready" as const,
  sheet: SHEET,
  busyCell: null,
  errorKey: null,
  onSave: () => {},
  onRetry: () => {},
};
const render = (over: Record<string, unknown>, locale: "en" | "vi" = "en") =>
  renderToStaticMarkup(createElement(TimetableSheetView, { locale, ...base, ...over } as never));

describe("TimetableSheetView", () => {
  it("shows editable cells as inputs and computed cells as locked text", () => {
    const html = render({});
    expect(html).toContain('value="Write report"');
    expect((html.match(/<input/g) ?? []).length).toBe(6);
    expect(html).toContain(en["sheet.col.state"]);
    expect(html).toContain(en["sheet.locked"]);
    expect(html).toContain(en["sheet.planned_minutes"].replace("{minutes}", "60"));
  });
  it("renders no inputs for a past week", () => {
    const locked = {
      ...SHEET,
      readOnly: true,
      rows: SHEET.rows.map((r) => ({
        ...r,
        cells: r.cells.map((c) => ({ ...c, editable: false })),
      })),
    };
    const html = render({ sheet: locked });
    expect(html).not.toContain("<input");
    expect(html).toContain(en["sheet.read_only"]);
  });
  it("shows a save error as an alert", () => {
    expect(render({ errorKey: "sheet.reject.locked_cell" })).toContain(
      en["sheet.reject.locked_cell"],
    );
  });
  it("shows loading, empty and error states", () => {
    expect(render({ status: "loading", sheet: null })).toContain(en["sheet.loading"]);
    expect(render({ status: "empty", sheet: null })).toContain(en["sheet.empty"]);
    const err = render({ status: "error", sheet: null });
    expect(err).toContain(en["sheet.error"]);
    expect(err).toContain(en["sheet.retry"]);
  });
  it("renders in Vietnamese", () => {
    expect(render({}, "vi")).toContain(vi_["sheet.col.title"]);
  });
  it("has the same sheet keys in both locales and the route is in the schedule area", () => {
    const keys = (o: Record<string, string>) =>
      Object.keys(o).filter((k) => k.startsWith("sheet."));
    expect(keys(vi_).sort()).toEqual(keys(en).sort());
    expect(keys(en).length).toBeGreaterThan(12);
    expect(areaForRoute("/schedule/sheet")).toBe("schedule");
  });
});
