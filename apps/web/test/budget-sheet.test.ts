import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { BudgetSheetView } from "../components/budget-sheet-view";
import {
  BUDGET_SHEET_TABS,
  cellValue,
  loadBudgetSheet,
  saveBudgetCell,
  type BudgetSheet,
} from "../lib/budget-sheet";
import { areaForRoute } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CAT = "33333333-3333-4333-8333-333333333333";
const TX = "44444444-4444-4444-8444-444444444444";
const SHEET: BudgetSheet = {
  cycle: { id: "c1", state: "open", firstDay: "2026-11-01" },
  readOnly: false,
  tabs: {
    categories: [
      {
        entityId: CAT,
        cells: [
          { field: "name", value: "Food", editable: true },
          { field: "shortCode", value: "FOOD", editable: false },
          { field: "cycleLimitVnd", value: 4000000, editable: true },
          { field: "weeklyLimitVnd", value: 1000000, editable: false },
        ],
      },
    ],
    accounts: [
      {
        entityId: "a1",
        cells: [
          { field: "name", value: "Main", editable: false },
          { field: "emailNotificationsConfirmed", value: true, editable: false },
        ],
      },
    ],
    weeklyPlan: [
      {
        entityId: "p1",
        cells: [
          { field: "category", value: "Food", editable: false },
          { field: "amountVnd", value: 250000, editable: true },
          { field: "status", value: "matched", editable: false },
        ],
      },
    ],
    ledger: [
      {
        entityId: TX,
        cells: [
          { field: "occurredAt", value: "2026-11-02T03:00:00Z", editable: false },
          { field: "amountVnd", value: 90000, editable: false },
        ],
      },
      {
        entityId: "o1",
        cells: [
          { field: "weekIndex", value: 1, editable: false },
          { field: "excessVnd", value: 5000, editable: false },
        ],
      },
    ],
    surplus: [],
  },
};

const base = {
  status: "ready" as const,
  sheet: SHEET,
  tab: "categories" as const,
  busyCell: null,
  errorKey: null,
  onSave: () => {},
  onRetry: () => {},
  onTab: () => {},
};
const render = (over: Record<string, unknown>, locale: "en" | "vi" = "en") =>
  renderToStaticMarkup(createElement(BudgetSheetView, { locale, ...base, ...over } as never));
const text = (key: string) => (en as Record<string, string>)[key];

describe("loadBudgetSheet", () => {
  it("reads the sheet and asks for the tab", async () => {
    const doFetch = vi.fn(async (_u: string) => json(200, { ok: true, data: SHEET }));
    const res = await loadBudgetSheet("weeklyPlan", doFetch);
    expect(res.status).toBe("ready");
    expect(doFetch.mock.calls[0]![0]).toBe("/api/budget/sheet?tab=weeklyPlan");
  });
  it("is empty without a cycle and error on failure or bad body", async () => {
    expect((await loadBudgetSheet("ledger", async () => json(404, {}))).status).toBe("empty");
    expect((await loadBudgetSheet("ledger", async () => json(500, {}))).status).toBe("error");
    expect(
      (await loadBudgetSheet("ledger", async () => json(200, { ok: true, data: {} }))).status,
    ).toBe("error");
    expect(
      (
        await loadBudgetSheet("ledger", async () => {
          throw new Error("x");
        })
      ).status,
    ).toBe("error");
  });
});

describe("cellValue", () => {
  it("converts VND cells to numbers and keeps text", () => {
    expect(cellValue("cycleLimitVnd", "4000000")).toBe(4000000);
    expect(cellValue("amountVnd", "abc")).toBeNaN();
    expect(cellValue("amountVnd", "")).toBeNaN();
    expect(cellValue("name", "Food")).toBe("Food");
  });
});

describe("saveBudgetCell", () => {
  it("posts one budget plan cell edit", async () => {
    const doFetch = vi.fn(async (_u: string, _i?: RequestInit) =>
      json(200, { ok: true, data: { status: "applied" } }),
    );
    expect(await saveBudgetCell("weeklyPlan", CAT, "amountVnd", 1, doFetch)).toEqual({ ok: true });
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe("/api/budget/sheet/cells");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      sheet: "budget",
      tab: "weeklyPlan",
      entityId: CAT,
      field: "amountVnd",
      value: 1,
    });
  });
  it("maps a rejection and a failure to locale keys", async () => {
    const rejected = await saveBudgetCell("ledger", TX, "amountVnd", 1, async () =>
      json(200, { ok: true, data: { status: "rejected", reason: "locked_cell" } }),
    );
    expect(rejected).toEqual({ ok: false, errorKey: "budgetsheet.reject.locked_cell" });
    const failed = await saveBudgetCell("ledger", TX, "amountVnd", 1, async () => json(500, {}));
    expect(failed).toEqual({ ok: false, errorKey: "budgetsheet.error.save" });
  });
});

describe("BudgetSheetView", () => {
  it("has the five tabs", () => {
    expect(BUDGET_SHEET_TABS).toHaveLength(5);
    const html = render({});
    for (const tab of BUDGET_SHEET_TABS) expect(html).toContain(text(`budgetsheet.tab.${tab}`));
  });
  it("renders plan cells as inputs and every other cell as locked text", () => {
    const html = render({});
    expect((html.match(/<input/g) ?? []).length).toBe(2);
    expect(html).toContain('value="Food"');
    expect(html).toContain('value="4000000"');
    expect(html).toContain("FOOD");
    expect(html).toContain(text("budgetsheet.locked"));
  });
  it("renders booked ledger and read-only cycles without inputs", () => {
    expect(render({ tab: "ledger" })).not.toContain("<input");
    expect(render({ tab: "accounts" })).not.toContain("<input");
    const closed = {
      ...SHEET,
      readOnly: true,
      tabs: {
        ...SHEET.tabs,
        categories: SHEET.tabs.categories!.map((r) => ({
          ...r,
          cells: r.cells.map((c) => ({ ...c, editable: false })),
        })),
      },
    };
    const html = render({ sheet: closed });
    expect(html).not.toContain("<input");
    expect(html).toContain(text("budgetsheet.read_only"));
  });
  it("shows a tab with no rows as empty", () => {
    expect(render({ tab: "surplus" })).toContain(text("budgetsheet.tab_empty"));
  });
  it("shows a save error, and loading, empty and error states", () => {
    expect(render({ errorKey: "budgetsheet.reject.booked_fact" })).toContain(
      text("budgetsheet.reject.booked_fact"),
    );
    expect(render({ status: "loading", sheet: null })).toContain(text("budgetsheet.loading"));
    expect(render({ status: "empty", sheet: null })).toContain(text("budgetsheet.empty"));
    const err = render({ status: "error", sheet: null });
    expect(err).toContain(text("budgetsheet.error"));
    expect(err).toContain(text("budgetsheet.retry"));
  });
  it("renders in Vietnamese with matching locale keys and sits in the budget area", () => {
    expect(render({}, "vi")).toContain((vi_ as Record<string, string>)["budgetsheet.col.name"]);
    const keys = (o: Record<string, string>) =>
      Object.keys(o).filter((k) => k.startsWith("budgetsheet."));
    expect(keys(vi_).sort()).toEqual(keys(en).sort());
    expect(areaForRoute("/budget/sheet")).toBe("budget");
  });
});
