import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { DebtsView } from "../components/debts-view";
import { NAV_ITEMS } from "../lib/nav";
import { loadDebts, splitDebts } from "../lib/debts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const debt = (over: Record<string, unknown>) => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "payable",
  person: "Lan",
  amountVnd: 500_000,
  settledVnd: 100_000,
  dueAt: "2026-12-05T17:00:00.000Z",
  state: "partially_settled",
  fundingCategoryId: null,
  ...over,
});
const debts = [
  debt({}),
  debt({
    id: "22222222-2222-4222-8222-222222222222",
    kind: "receivable",
    person: "Minh",
    amountVnd: 300_000,
    settledVnd: 0,
    state: "open",
    dueAt: null,
  }),
  debt({ id: "33333333-3333-4333-8333-333333333333", kind: "receivable", state: "settled" }),
];

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(DebtsView, {
      locale: "en",
      status: "ready",
      debts,
      timeZone: "Asia/Ho_Chi_Minh",
      onRefresh: () => {},
      ...props,
    } as never),
  );

describe("open debts page", () => {
  it("lists payables and receivables with due dates", () => {
    const html = render({});
    expect(html).toContain(en["debts.payables"]);
    expect(html).toContain(en["debts.receivables"]);
    expect(html).toContain("Lan");
    expect(html).toContain("Minh");
    expect(html).toContain("400,000 VND");
    expect(html).toContain("Dec 6, 2026");
    expect(html).toContain(en["debts.no_due_date"]);
  });

  it("hides closed debts", () => {
    expect(splitDebts(debts as never).receivables).toHaveLength(1);
    expect(splitDebts(debts as never).payables).toHaveLength(1);
  });

  it("renders loading, empty and error states", () => {
    expect(render({ status: "loading" })).toContain(en["debts.loading"]);
    expect(render({ status: "empty" })).toContain(en["debts.empty"]);
    const err = render({ status: "error" });
    expect(err).toContain(en["debts.error"]);
    expect(err).toContain(en["debts.retry"]);
  });

  it("renders Vietnamese", () => {
    expect(render({ locale: "vi" })).toContain(vi["debts.payables"]);
  });

  it("has locale keys in both languages and a nav entry", () => {
    for (const k of Object.keys(en).filter((key) => key.startsWith("debts."))) {
      expect(vi).toHaveProperty([k]);
    }
    expect(NAV_ITEMS.some((i) => i.href === "/debts")).toBe(true);
  });
});

describe("loadDebts", () => {
  it("returns ready, empty and error", async () => {
    expect(await loadDebts(async () => json(200, { ok: true, data: { debts } }))).toMatchObject({
      status: "ready",
    });
    expect(
      await loadDebts(async () => json(200, { ok: true, data: { debts: [debts[2]] } })),
    ).toEqual({ status: "empty" });
    expect(await loadDebts(async () => json(500, {}))).toEqual({ status: "error" });
    expect(
      await loadDebts(async () => {
        throw new Error("x");
      }),
    ).toEqual({ status: "error" });
  });
});
