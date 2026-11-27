import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createDebtOpener, isPastWriteOffPrompt, resolveDueAt } from "../src/debts";
import { createWeekClosedHandler } from "../src/overspend";
import { getCategoryBalances } from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");
const DAY = 86_400_000;
const FIRST_DAY = "2026-03-02";
const WEEK_END = Date.parse("2026-03-09T00:00:00Z");

describe("resolveDueAt (pure)", () => {
  const cases = [
    {
      name: "keeps a requested due date",
      requested: "2026-04-01T00:00:00.000Z",
      days: 7,
      expected: "2026-04-01T00:00:00.000Z",
    },
    {
      name: "default: opened plus the default days",
      requested: null,
      days: 7,
      expected: "2026-03-12T10:00:00.000Z",
    },
    {
      name: "zero default days: due at once",
      requested: null,
      days: 0,
      expected: "2026-03-05T10:00:00.000Z",
    },
    {
      name: "30 default days",
      requested: null,
      days: 30,
      expected: "2026-04-04T10:00:00.000Z",
    },
  ];
  it.each(cases)("$name", ({ requested, days, expected }) => {
    expect(resolveDueAt(NOW, requested, days)).toBe(expected);
  });
});

describe("isPastWriteOffPrompt (pure)", () => {
  const due = "2026-03-01T00:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(due) + ms);
  const cases = [
    { name: "before the due date", now: at(-1), days: 7, expected: false },
    { name: "at the due date", now: at(0), days: 7, expected: false },
    { name: "exactly at the prompt days", now: at(7 * DAY), days: 7, expected: false },
    { name: "one ms past the prompt days", now: at(7 * DAY + 1), days: 7, expected: true },
    { name: "zero prompt days, one ms overdue", now: at(1), days: 0, expected: true },
    { name: "zero prompt days, at the due date", now: at(0), days: 0, expected: false },
    { name: "14 prompt days, day 10", now: at(10 * DAY), days: 14, expected: false },
  ];
  it.each(cases)("$name", ({ now, days, expected }) => {
    expect(isPastWriteOffPrompt(due, now, days)).toBe(expected);
  });
});

async function seeded(settings: Record<string, unknown> = {}) {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  const newId = () => `id-${++n}`;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  store.get("u1")!.cycle.state = "running";
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const publish = (e: EventEnvelope) => {
    if (fail.publish) throw new Error("bus down");
    published.push(e);
  };
  const clock = { now: NOW };
  const readSettings = async () => settings;
  const opener = createDebtOpener({
    store,
    now: () => clock.now,
    newId,
    publish,
    readSettings,
  });
  const onWeekClosed = createWeekClosedHandler({
    store,
    now: () => clock.now,
    publish,
    readSettings,
  });
  const weekClosed = (): EventEnvelope =>
    ({
      id: "wc-1",
      type: "week.closed",
      occurredAt: new Date(WEEK_END).toISOString(),
      userId: "u1",
      schemaVersion: 1,
      payload: { firstDay: FIRST_DAY, weekIndexInCycle: 1 },
    }) as unknown as EventEnvelope;
  return { store, opener, onWeekClosed, weekClosed, published, fail, clock };
}

const ofType = (p: EventEnvelope[], type: string) => p.filter((e) => e.type === type);

describe("opening a debt (MW-061, criterion 1)", () => {
  it("a loan to a friend emits debt.opened and has a due date", async () => {
    const s = await seeded();
    const category = s.store.get("u1")!.categories[0]!;
    const result = await s.opener.open("u1", {
      kind: "receivable",
      person: "Minh",
      amountVnd: 500_000,
      dueAt: null,
      fundingCategoryId: category.id,
    });
    expect(result.ok).toBe(true);
    const opened = ofType(s.published, "debt.opened");
    expect(opened).toHaveLength(1);
    const payload = (opened[0] as EventEnvelope<"debt.opened">).payload;
    expect(payload.kind).toBe("receivable");
    expect(payload.amountVnd).toBe(500_000);
    expect(payload.dueAt).toBe("2026-03-12T10:00:00.000Z");
    const stored = s.store.get("u1")!.debts[0]!;
    expect(stored.dueAt).toBe("2026-03-12T10:00:00.000Z");
    expect(stored.state).toBe("open");
    expect(stored.settledVnd).toBe(0);
    expect(s.store.get("u1")!.audit.some((a) => a.action === "debt_opened")).toBe(true);
  });

  it("the default due days are a setting", async () => {
    const s = await seeded({ "debt.receivable_write_off_prompt_days": 3 });
    await s.opener.open("u1", {
      kind: "receivable",
      person: "Minh",
      amountVnd: 100_000,
      dueAt: null,
      fundingCategoryId: null,
    });
    expect(s.store.get("u1")!.debts[0]!.dueAt).toBe("2026-03-08T10:00:00.000Z");
  });

  it("keeps a requested due date and also opens a payable", async () => {
    const s = await seeded();
    await s.opener.open("u1", {
      kind: "payable",
      person: "Lan",
      amountVnd: 2_000_000,
      dueAt: "2026-05-01T00:00:00.000Z",
      fundingCategoryId: null,
    });
    const payload = (ofType(s.published, "debt.opened")[0] as EventEnvelope<"debt.opened">).payload;
    expect(payload.kind).toBe("payable");
    expect(payload.dueAt).toBe("2026-05-01T00:00:00.000Z");
  });

  const invalid = [
    { name: "zero amount", amountVnd: 0, fundingCategoryId: null },
    { name: "negative amount", amountVnd: -5, fundingCategoryId: null },
    { name: "fractional amount", amountVnd: 10.5, fundingCategoryId: null },
    { name: "unknown funding category", amountVnd: 1000, fundingCategoryId: "nope" },
  ];
  for (const row of invalid) {
    it(`rejects ${row.name}`, async () => {
      const s = await seeded();
      const result = await s.opener.open("u1", {
        kind: "receivable",
        person: "Minh",
        amountVnd: row.amountVnd,
        dueAt: null,
        fundingCategoryId: row.fundingCategoryId,
      });
      expect(result.ok).toBe(false);
      expect(s.store.get("u1")!.debts).toHaveLength(0);
      expect(ofType(s.published, "debt.opened")).toHaveLength(0);
    });
  }

  it("a failed publish is retried and debt.opened is published once", async () => {
    const s = await seeded();
    s.fail.publish = true;
    const request = {
      kind: "receivable" as const,
      person: "Minh",
      amountVnd: 100_000,
      dueAt: null,
      fundingCategoryId: null,
    };
    await expect(s.opener.open("u1", request)).rejects.toThrow();
    s.fail.publish = false;
    await s.opener.announceOwed("u1");
    await s.opener.announceOwed("u1");
    expect(ofType(s.published, "debt.opened")).toHaveLength(1);
  });
});

describe("overdue receivables are written off at the week close (MW-061, criterion 2)", () => {
  async function withReceivable(settings: Record<string, unknown> = {}) {
    const s = await seeded(settings);
    const category = s.store.get("u1")!.categories.find((c) => c.priority === "want")!;
    await s.opener.open("u1", {
      kind: "receivable",
      person: "Minh",
      amountVnd: 500_000,
      dueAt: "2026-03-01T00:00:00.000Z",
      fundingCategoryId: category.id,
    });
    return { ...s, category };
  }

  it("books the open amount as an expense of the funding category", async () => {
    const s = await withReceivable();
    s.clock.now = new Date(WEEK_END + 1000);
    await s.onWeekClosed(s.weekClosed());
    const record = s.store.get("u1")!;
    const debt = record.debts[0]!;
    expect(debt.state).toBe("written_off");
    const txn = record.transactions.find((t) => t.receiptId === `debt:${debt.id}`)!;
    expect(txn.amountVnd).toBe(500_000);
    expect(txn.direction).toBe("out");
    expect(txn.categoryId).toBe(s.category.id);
    expect(getCategoryBalances(record).find((b) => b.categoryId === s.category.id)!.spentVnd).toBe(
      500_000,
    );
    const written = ofType(s.published, "debt.written_off")[0] as EventEnvelope<"debt.written_off">;
    expect(written.payload).toEqual({
      debtId: debt.id,
      amountVnd: 500_000,
      bookedToCategoryId: s.category.id,
    });
    expect(ofType(s.published, "txn.recorded").map((e) => e.id)).toContain(
      `txn-recorded-${txn.id}`,
    );
    expect(record.audit.some((a) => a.action === "debt_written_off")).toBe(true);
  });

  it("writes off only what is still open after a partial repayment", async () => {
    const s = await withReceivable();
    s.store.get("u1")!.debts[0]!.settledVnd = 200_000;
    s.store.get("u1")!.debts[0]!.state = "partially_settled";
    s.clock.now = new Date(WEEK_END + 1000);
    await s.onWeekClosed(s.weekClosed());
    const record = s.store.get("u1")!;
    expect(record.transactions.at(-1)!.amountVnd).toBe(300_000);
    expect(
      (ofType(s.published, "debt.written_off")[0] as EventEnvelope<"debt.written_off">).payload
        .amountVnd,
    ).toBe(300_000);
  });

  const rows = [
    { name: "not yet past the prompt days", closeAt: "2026-03-07T00:00:00.000Z", off: false },
    { name: "exactly at the prompt days", closeAt: "2026-03-08T00:00:00.000Z", off: false },
    { name: "past the prompt days", closeAt: "2026-03-09T00:00:01.000Z", off: true },
  ];
  for (const row of rows) {
    it(`default 7 days: ${row.name}`, async () => {
      const s = await withReceivable();
      s.clock.now = new Date(row.closeAt);
      await s.onWeekClosed(s.weekClosed());
      expect(s.store.get("u1")!.debts[0]!.state).toBe(row.off ? "written_off" : "open");
    });
  }

  it("the prompt days are a setting", async () => {
    const s = await withReceivable({ "debt.receivable_write_off_prompt_days": 30 });
    s.clock.now = new Date(WEEK_END + 1000);
    await s.onWeekClosed(s.weekClosed());
    expect(s.store.get("u1")!.debts[0]!.state).toBe("open");
  });

  it("leaves payables, settled and already written off debts alone", async () => {
    const s = await withReceivable();
    const record = s.store.get("u1")!;
    record.debts.push(
      { ...record.debts[0]!, id: "p1", kind: "payable" },
      { ...record.debts[0]!, id: "s1", state: "settled", settledVnd: 500_000 },
    );
    s.clock.now = new Date(WEEK_END + 1000);
    await s.onWeekClosed(s.weekClosed());
    expect(record.debts.find((d) => d.id === "p1")!.state).toBe("open");
    expect(record.debts.find((d) => d.id === "s1")!.state).toBe("settled");
    expect(ofType(s.published, "debt.written_off")).toHaveLength(1);
  });

  it("is idempotent when the week close is delivered twice", async () => {
    const s = await withReceivable();
    s.clock.now = new Date(WEEK_END + 1000);
    await s.onWeekClosed(s.weekClosed());
    await s.onWeekClosed(s.weekClosed());
    const record = s.store.get("u1")!;
    expect(record.transactions.filter((t) => t.receiptId.startsWith("debt:"))).toHaveLength(1);
    expect(ofType(s.published, "debt.written_off")).toHaveLength(1);
  });

  it("without a funding category it books to the first want category", async () => {
    const s = await seeded();
    await s.opener.open("u1", {
      kind: "receivable",
      person: "Minh",
      amountVnd: 100_000,
      dueAt: "2026-03-01T00:00:00.000Z",
      fundingCategoryId: null,
    });
    s.clock.now = new Date(WEEK_END + 1000);
    await s.onWeekClosed(s.weekClosed());
    const record = s.store.get("u1")!;
    const first = [...record.categories]
      .filter((c) => c.priority === "want")
      .sort((a, b) => (a.wantOrder ?? 99) - (b.wantOrder ?? 99))[0]!;
    expect(record.transactions.at(-1)!.categoryId).toBe(first.id);
  });

  it("a failed publish is retried by the next delivery without booking twice", async () => {
    const s = await withReceivable();
    s.clock.now = new Date(WEEK_END + 1000);
    s.fail.publish = true;
    await expect(s.onWeekClosed(s.weekClosed())).rejects.toThrow();
    s.fail.publish = false;
    await s.onWeekClosed(s.weekClosed());
    const record = s.store.get("u1")!;
    expect(record.transactions.filter((t) => t.receiptId.startsWith("debt:"))).toHaveLength(1);
    expect(ofType(s.published, "debt.written_off")).toHaveLength(1);
  });
});
