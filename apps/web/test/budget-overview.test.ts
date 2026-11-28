import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { BudgetOverviewView } from "../components/budget-overview-view";
import { loadOverview, loadPenalties, loadTimeZone, type Overview } from "../lib/budget-overview";
import { loadTransferList } from "../lib/funding";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const overview: Overview = {
  cycle: {
    id: "c1",
    sequence: 3,
    weeks: 4,
    firstDay: "2026-11-01",
    state: "running",
    openedAt: "2026-11-01T00:00:00.000Z",
    closedAt: null,
    commitmentId: "k1",
  },
  weekIndex: 2,
  bankAccounts: [
    {
      id: "a1",
      name: "Daily bank",
      code: "VCB",
      kind: "spending",
      emailNotificationsConfirmed: true,
    },
    {
      id: "a2",
      name: "Penalty bank",
      code: "TCB",
      kind: "penalty_savings",
      emailNotificationsConfirmed: true,
    },
  ],
  categories: [
    {
      category: {
        id: "cat1",
        name: "Food",
        shortCode: "AN",
        priority: "need",
        kind: "variable",
        countsTowardSurplus: true,
        bankAccountId: "a1",
        cycleLimitVnd: 4_000_000,
        wantOrder: null,
      },
      weeklyLimitVnd: 1_000_000,
      spentVnd: 400_000,
      remainingVnd: 600_000,
    },
  ],
  transactions: [
    {
      id: "t1",
      receiptId: "r1",
      bankAccountId: "a1",
      direction: "out",
      amountVnd: 120_000,
      occurredAt: "2026-11-10T05:00:00.000Z",
      memo: "MW-C03W2-AN-01",
      counterparty: "Market",
      transactionType: "planned_transfer",
      reconciliationResult: "matched",
      categoryId: "cat1",
      plannedItemId: "p1",
      cycleId: "c1",
      weekIndex: 2,
      linkedTransactionId: null,
      adjustmentOf: null,
    },
  ],
  anomalies: [{ id: "an1", kind: "unknown_transaction", subjectRef: "txn:t9" }],
};
const penalty = {
  id: "pen1",
  source: "overspend",
  amountVnd: 50_000,
  status: "due",
  dueDate: "2026-11-30T00:00:00.000Z",
  transferCode: "MW-PH-C3W2-AN",
  paymentTransactionId: null,
  auditRefs: [],
  contractId: "k1",
};

describe("loadOverview", () => {
  it("reads and parses the overview", async () => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      return json(200, { ok: true, data: overview });
    };
    const res = await loadOverview(f as never);
    expect(calls).toEqual(["/api/budget/overview"]);
    expect(res.status === "ready" && res.overview.categories).toHaveLength(1);
  });

  it("is empty without a running cycle, error on failure or bad data", async () => {
    const run = async (f: () => Promise<Response>) => (await loadOverview(f as never)).status;
    expect(await run(async () => json(404, { ok: false }))).toBe("empty");
    expect(await run(async () => json(500, { ok: false }))).toBe("error");
    expect(await run(async () => json(200, { ok: true, data: {} }))).toBe("error");
    expect(
      await run(async () =>
        json(200, {
          ok: true,
          data: { ...overview, cycle: { ...overview.cycle, state: "draft" } },
        }),
      ),
    ).toBe("empty");
    expect(
      await run(async () => {
        throw new Error("net");
      }),
    ).toBe("error");
  });
});

describe("loadPenalties", () => {
  it("keeps only due penalties", async () => {
    const f = async (url: string) => {
      expect(url).toBe("/api/penalties");
      return json(200, {
        ok: true,
        data: {
          penalties: [penalty, { ...penalty, id: "pen2", status: "paid" }],
          suspendedTotalVnd: 0,
        },
      });
    };
    const res = await loadPenalties(f as never);
    expect(res.status === "ready" && res.due.map((p) => p.id)).toEqual(["pen1"]);
  });

  it("reports an error on failure or bad data", async () => {
    expect((await loadPenalties((async () => json(502, {})) as never)).status).toBe("error");
    expect((await loadPenalties((async () => json(200, { ok: true })) as never)).status).toBe(
      "error",
    );
  });
});

describe("BudgetOverviewView", () => {
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(BudgetOverviewView, {
        locale: "en",
        status: "ready",
        overview,
        penalties: { status: "ready", due: [] },
        onRefresh: () => {},
        ...props,
      } as never),
    );

  it("shows categories with remaining limits and recent transactions", () => {
    const html = view({});
    expect(html).toContain("Food");
    expect(html).toContain("600,000");
    expect(html).toContain("1,000,000");
    expect(html).toContain("Market");
    expect(html).toContain("120,000");
    expect(html).toContain(en["budget.reconciliation.matched"]);
  });

  it("shows anomalies", () => {
    expect(view({})).toContain(en["budget.anomaly.unknown_transaction"]);
  });

  it("shows a due penalty with its payment instructions", () => {
    const html = view({ penalties: { status: "ready", due: [penalty] } });
    expect(html).toContain("50,000");
    expect(html).toContain("MW-PH-C3W2-AN");
    expect(html).toContain("Penalty bank");
    expect(html).toContain(en["budget.penalty.instructions"]);
  });

  it("shows no penalty content when nothing is due", () => {
    expect(view({})).not.toContain("MW-PH-");
  });

  it("keeps the page when only penalties fail", () => {
    const html = view({ penalties: { status: "error", due: [] } });
    expect(html).toContain("Food");
    expect(html).toContain(en["budget.penalty.error"]);
  });

  it("shows dates in the user's time zone", () => {
    const html = view({
      timeZone: "Pacific/Honolulu",
      penalties: { status: "ready", due: [penalty] },
    });
    expect(html).toContain("Nov 9, 2026");
    expect(html).toContain("Nov 29, 2026");
    expect(html).not.toContain("Nov 10, 2026");
    expect(view({ timeZone: "Asia/Ho_Chi_Minh" })).toContain("Nov 10, 2026");
  });

  it("has loading, empty and error states with a retry", () => {
    expect(view({ status: "loading", overview: null })).toContain(en["budget.loading"]);
    expect(view({ status: "empty", overview: null })).toContain(en["budget.empty"]);
    const err = view({ status: "error", overview: null, locale: "vi" });
    expect(err).toContain(vi["budget.error"]);
    expect(err).toContain(vi["budget.retry"]);
  });

  it("has every budget key in both locales", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("budget."));
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) expect(vi).toHaveProperty([k]);
  });
});

describe("transfer list on the budget page", () => {
  const account = {
    bankAccountId: "a1",
    name: "Daily bank",
    code: "VCB",
    requiredVnd: 5_000_000,
    memo: "MW-F-C3-VCB",
    funded: true,
  };
  const view = (transfers: unknown) =>
    renderToStaticMarkup(
      createElement(BudgetOverviewView, {
        locale: "en",
        status: "ready",
        overview,
        penalties: { status: "ready", due: [] },
        transfers,
        timeZone: "UTC",
        onRefresh: () => {},
      } as never),
    );

  it("loads the transfer list of a running cycle", async () => {
    const f = async () =>
      json(200, {
        ok: true,
        data: { cycle: { ...overview.cycle, state: "running" }, accounts: [account] },
      });
    const res = await loadTransferList(f as never);
    expect(res.status === "ready" && res.accounts).toHaveLength(1);
  });

  it("shows accounts with the receipt-verified status", () => {
    const html = view({ status: "ready", accounts: [account] });
    expect(html).toContain(en["budget.transfers.title"]);
    expect(html).toContain("MW-F-C3-VCB");
    expect(html).toContain("5,000,000");
    expect(html).toContain(en["funding.status.funded"]);
  });

  it("has empty and error states", () => {
    expect(view({ status: "empty", accounts: [] })).toContain(en["budget.transfers.empty"]);
    expect(view({ status: "error", accounts: [] })).toContain(en["budget.transfers.error"]);
  });
});

describe("loadTimeZone", () => {
  it("reads calendar.time_zone from the settings", async () => {
    const f = async (url: string) => {
      expect(url).toBe("/api/settings");
      return json(200, { ok: true, data: { values: { "calendar.time_zone": "Asia/Tokyo" } } });
    };
    expect(await loadTimeZone(f)).toBe("Asia/Tokyo");
  });

  it("falls back to the default on failure, bad data or an invalid zone", async () => {
    const fallback = "Asia/Ho_Chi_Minh";
    expect(await loadTimeZone(async () => json(500, {}))).toBe(fallback);
    expect(await loadTimeZone(async () => json(200, { nope: 1 }))).toBe(fallback);
    expect(
      await loadTimeZone(async () =>
        json(200, { ok: true, data: { values: { "calendar.time_zone": "Mars/Base" } } }),
      ),
    ).toBe(fallback);
    expect(
      await loadTimeZone(async () => {
        throw new Error("down");
      }),
    ).toBe(fallback);
  });
});
