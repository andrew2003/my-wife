import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createReceiptHandler } from "../src/accounts";
import { createContractSignedHandler, createCycleApprover } from "../src/approval";
import { createFundingHandler } from "../src/funding";

const NOW = new Date("2026-03-05T10:00:00Z");
const LATER = new Date("2026-03-06T10:00:00Z");

function receipt(o: {
  hint?: string;
  memo: string;
  ref: string;
  amount?: number;
  direction?: "in" | "out";
  userId?: string;
}): EventEnvelope {
  return {
    id: `ev-${o.ref}`,
    type: "receipt.parsed",
    occurredAt: NOW.toISOString(),
    userId: o.userId ?? "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${o.ref}`,
      bankTransactionRef: o.ref,
      bankAccountHint: o.hint ?? "X",
      direction: o.direction ?? "in",
      amountVnd: o.amount ?? 1000,
      currency: "VND",
      counterparty: null,
      memo: o.memo,
      occurredAt: NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as unknown as EventEnvelope;
}

async function seeded() {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const record = store.get("u1")!;
  const requests: EventEnvelope[] = [];
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  await createContractSignedHandler({ store })({
    id: "s1",
    type: "contract.signed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { contractId: "c1", cycleId: record.cycle.id, version: 1 },
  } as EventEnvelope);
  const confirm = createReceiptHandler({ store, now: () => NOW });
  for (const a of record.accounts) await confirm(receipt({ hint: a.code, memo: "", ref: a.code }));
  await createCycleApprover({
    store,
    now: () => NOW,
    publish: (e) => void requests.push(e),
  })({ userId: "u1", cycleId: record.cycle.id, commitmentId: "c1" });
  const transfers = (requests[0] as EventEnvelope<"cycle.funds_requested">).payload.transfers;
  const funding = createFundingHandler({
    store,
    now: () => LATER,
    publish: (e) => {
      if (fail.publish) throw new Error("bus down");
      published.push(e);
    },
  });
  return { store, record, transfers, funding, published, fail };
}
type Setup = Awaited<ReturnType<typeof seeded>>;

/** Sends the exact required amount with the right code for each transfer except `skip`. */
async function fundAll(s: Setup, skip: string[] = []) {
  for (const t of s.transfers) {
    if (skip.includes(t.bankAccountId) || t.requiredVnd === 0) continue;
    await s.funding(
      receipt({ memo: t.memo, ref: `ref-${t.bankAccountId}`, amount: t.requiredVnd }),
    );
  }
}

const opened = (s: Setup) => s.published.filter((e) => e.type === "cycle.opened");
const firstPaid = (s: Setup) => s.transfers.find((t) => t.requiredVnd > 0)!;

describe("open cycle on funding (criterion 1)", () => {
  it("stays awaiting_funds while one account is short, then opens once", async () => {
    const s = await seeded();
    const short = firstPaid(s);
    await fundAll(s, [short.bankAccountId]);
    expect(s.store.get("u1")!.cycle.state).toBe("awaiting_funds");
    expect(opened(s)).toHaveLength(0);

    await s.funding(receipt({ memo: short.memo, ref: "last", amount: short.requiredVnd }));
    const cycle = s.store.get("u1")!.cycle;
    expect(cycle.state).toBe("running");
    expect(cycle.openedAt).toBe(LATER.toISOString());
    expect(opened(s)).toHaveLength(1);
    const ev = opened(s)[0] as EventEnvelope<"cycle.opened">;
    expect(ev.payload).toEqual({ cycleId: cycle.id, sequence: 1, firstDay: cycle.firstDay });
    expect(ev.id).toBe(`opened-${cycle.id}`);
    expect(s.store.get("u1")!.audit.some((a) => a.action === "cycle_opened")).toBe(true);
  });

  it("emits cycle.opened once even when repeats and later receipts arrive", async () => {
    const s = await seeded();
    await fundAll(s);
    await fundAll(s);
    const t = firstPaid(s);
    await s.funding(receipt({ memo: t.memo, ref: "extra", amount: t.requiredVnd }));
    expect(opened(s)).toHaveLength(1);
    expect(s.store.get("u1")!.audit.filter((a) => a.action === "cycle_opened")).toHaveLength(1);
  });

  it("retries a failed publish on the next delivery without a second open", async () => {
    const s = await seeded();
    s.fail.publish = true;
    await expect(fundAll(s)).rejects.toThrow("bus down");
    expect(s.store.get("u1")!.cycle.state).toBe("running");
    expect(opened(s)).toHaveLength(0);
    s.fail.publish = false;
    const t = firstPaid(s);
    await s.funding(receipt({ memo: t.memo, ref: "retry", amount: t.requiredVnd }));
    expect(opened(s)).toHaveLength(1);
    await s.funding(receipt({ memo: t.memo, ref: "retry2", amount: t.requiredVnd }));
    expect(opened(s)).toHaveLength(1);
    expect(s.store.get("u1")!.audit.filter((a) => a.action === "cycle_opened")).toHaveLength(1);
  });

  it("does nothing for an unknown user or a cycle that is not awaiting funds", async () => {
    const s = await seeded();
    await s.funding(receipt({ memo: "MW-F-C01-MAIN", ref: "z", userId: "nobody" }));
    s.store.get("u1")!.cycle.state = "draft";
    await fundAll(s);
    expect(s.store.get("u1")!.cycle.state).toBe("draft");
    expect(s.store.get("u1")!.fundings).toHaveLength(0);
    expect(opened(s)).toHaveLength(0);
  });
});

describe("funding receipt matching (criterion 2)", () => {
  const rows: {
    name: string;
    memo: (code: string) => string;
    amount: (required: number) => number;
    direction?: "in" | "out";
    counts: boolean;
  }[] = [
    { name: "exact amount", memo: (c) => c, amount: (r) => r, counts: true },
    { name: "more than required", memo: (c) => c, amount: (r) => r + 1, counts: true },
    { name: "one VND short", memo: (c) => c, amount: (r) => r - 1, counts: false },
    { name: "zero amount", memo: (c) => c, amount: () => 0, counts: false },
    { name: "wrong code", memo: () => "MW-F-C01-NOPE", amount: (r) => r, counts: false },
    {
      name: "wrong cycle sequence",
      memo: (c) => c.replace("C01", "C02"),
      amount: (r) => r,
      counts: false,
    },
    { name: "no code", memo: () => "thanks", amount: (r) => r, counts: false },
    {
      name: "outgoing transfer",
      memo: (c) => c,
      amount: (r) => r,
      direction: "out",
      counts: false,
    },
    {
      name: "bank-mangled memo normalizes to the code",
      memo: (c) => `chuyen khoan ${c.toLowerCase().replace(/-/g, " ")} cam on`,
      amount: (r) => r,
      counts: true,
    },
  ];
  it.each(rows)("$name", async ({ memo, amount, direction, counts }) => {
    const s = await seeded();
    const t = firstPaid(s);
    await s.funding(
      receipt({ memo: memo(t.memo), ref: "r1", amount: amount(t.requiredVnd), direction }),
    );
    expect(s.store.get("u1")!.fundings).toHaveLength(counts ? 1 : 0);
  });

  it("ignores a repeat of the same bankTransactionRef", async () => {
    const s = await seeded();
    const t = firstPaid(s);
    await s.funding(receipt({ memo: t.memo, ref: "same", amount: t.requiredVnd }));
    await s.funding(receipt({ memo: t.memo, ref: "same", amount: t.requiredVnd }));
    expect(s.store.get("u1")!.fundings).toHaveLength(1);
  });

  it("a ref already used by one account cannot fund another", async () => {
    const s = await seeded();
    const [a, b] = s.transfers.filter((t) => t.requiredVnd > 0);
    await s.funding(receipt({ memo: a!.memo, ref: "dup", amount: a!.requiredVnd }));
    await s.funding(receipt({ memo: b!.memo, ref: "dup", amount: b!.requiredVnd }));
    expect(s.store.get("u1")!.fundings.map((f) => f.bankAccountId)).toEqual([a!.bankAccountId]);
  });

  it("records the receipt facts with an audit entry", async () => {
    const s = await seeded();
    const t = firstPaid(s);
    await s.funding(receipt({ memo: t.memo, ref: "audit", amount: t.requiredVnd }));
    expect(s.store.get("u1")!.fundings[0]).toMatchObject({
      bankAccountId: t.bankAccountId,
      bankTransactionRef: "audit",
      amountVnd: t.requiredVnd,
    });
    expect(s.store.get("u1")!.audit.some((a) => a.action === "account_funded")).toBe(true);
  });
});
