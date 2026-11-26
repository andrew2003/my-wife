import { describe, expect, it } from "vitest";
import type { BankAccount, BudgetCategory, EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createReceiptHandler } from "../src/accounts";
import {
  buildFundRequests,
  createContractSignedHandler,
  createCycleApprover,
} from "../src/approval";

const NOW = new Date("2026-03-05T10:00:00Z");

async function seeded() {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  const onboarding = createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: () => undefined,
  });
  await onboarding({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const approver = createCycleApprover({
    store,
    now: () => NOW,
    publish: (e) => {
      if (fail.publish) throw new Error("bus down");
      published.push(e);
    },
  });
  const signed = createContractSignedHandler({ store });
  const receipts = createReceiptHandler({ store, now: () => NOW });
  const record = store.get("u1")!;
  return { store, approver, signed, receipts, published, fail, record };
}

type Setup = Awaited<ReturnType<typeof seeded>>;

const contractSigned = (contractId: string, cycleId: string, userId = "u1"): EventEnvelope =>
  ({
    id: `ev-${contractId}-${userId}`,
    type: "contract.signed",
    occurredAt: NOW.toISOString(),
    userId,
    schemaVersion: 1,
    payload: { contractId, cycleId, version: 1 },
  }) as EventEnvelope;

const receipt = (hint: string): EventEnvelope =>
  ({
    id: `ev-r-${hint}`,
    type: "receipt.parsed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${hint}`,
      bankTransactionRef: "ref",
      bankAccountHint: hint,
      direction: "in",
      amountVnd: 1000,
      currency: "VND",
      counterparty: null,
      memo: "",
      occurredAt: NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  }) as unknown as EventEnvelope;

async function confirmAll(s: Setup, except: string[] = []) {
  for (const a of s.record.accounts) {
    if (!except.includes(a.id)) await s.receipts(receipt(a.code));
  }
}

/** Signs the contract and confirms every account. */
async function ready(s: Setup) {
  await s.signed(contractSigned("c1", s.record.cycle.id));
  await confirmAll(s);
}

const req = (s: Setup) => ({
  userId: "u1",
  cycleId: s.record.cycle.id,
  commitmentId: "c1",
});

describe("approve cycle draft", () => {
  it("moves a draft to awaiting_funds and emits one code per account", async () => {
    const s = await seeded();
    await ready(s);
    const res = await s.approver(req(s));
    expect(res.ok).toBe(true);
    expect(s.store.get("u1")!.cycle.state).toBe("awaiting_funds");
    expect(s.store.get("u1")!.cycle.commitmentId).toBe("c1");
    expect(s.published).toHaveLength(1);
    const event = s.published[0] as EventEnvelope<"cycle.funds_requested">;
    expect(event.type).toBe("cycle.funds_requested");
    const ids = event.payload.transfers.map((t) => t.bankAccountId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(s.record.accounts.map((a) => a.id).sort());
    expect(s.store.get("u1")!.audit.at(-1)!.action).toBe("cycle_approved");
  });

  it("uses the funding code issued by budget as each transfer memo", async () => {
    const s = await seeded();
    await ready(s);
    await s.approver(req(s));
    const event = s.published[0] as EventEnvelope<"cycle.funds_requested">;
    for (const a of s.record.accounts) {
      const t = event.payload.transfers.find((x) => x.bankAccountId === a.id)!;
      expect(t.memo).toBe(`MW-F-C01-${a.code}`);
    }
  });

  it("requires the sum of the account's category limits", async () => {
    const s = await seeded();
    await ready(s);
    const res = await s.approver(req(s));
    if (!res.ok) throw new Error("expected ok");
    for (const t of res.data.transfers) {
      const sum = s.record.categories
        .filter((c) => c.bankAccountId === t.bankAccountId)
        .reduce((acc, c) => acc + c.cycleLimitVnd, 0);
      expect(t.requiredVnd).toBe(sum);
    }
  });

  it.each(["awaiting_funds", "running", "closing", "closed"] as const)(
    "rejects a cycle in %s and leaves the state unchanged",
    async (state) => {
      const s = await seeded();
      await ready(s);
      s.record.cycle.state = state;
      s.record.fundsAnnounced = true;
      const res = await s.approver(req(s));
      expect(res).toMatchObject({ ok: false, error: { code: "budget.cycle_not_draft" } });
      expect(s.store.get("u1")!.cycle.state).toBe(state);
      expect(s.published).toHaveLength(0);
    },
  );

  it("rejects without a contract.signed for the user and stays draft", async () => {
    const s = await seeded();
    await confirmAll(s);
    const res = await s.approver(req(s));
    expect(res).toMatchObject({ ok: false, error: { code: "budget.contract_not_signed" } });
    expect(s.store.get("u1")!.cycle.state).toBe("draft");
    expect(s.published).toHaveLength(0);
  });

  it.each([
    ["another user", "c1", "u2", true],
    ["another contract id", "other", "u1", true],
    ["another cycle", "c1", "u1", false],
  ])("does not accept a contract signed by %s", async (_name, contractId, userId, ownCycle) => {
    const s = await seeded();
    await confirmAll(s);
    await s.signed(contractSigned(contractId, ownCycle ? s.record.cycle.id : "other-cycle", userId));
    const res = await s.approver(req(s));
    expect(res).toMatchObject({ ok: false, error: { code: "budget.contract_not_signed" } });
    expect(s.store.get("u1")!.cycle.state).toBe("draft");
  });

  it("rejects while an account holding categories is unconfirmed and stays draft", async () => {
    const s = await seeded();
    await s.signed(contractSigned("c1", s.record.cycle.id));
    const first = s.record.accounts[0]!;
    await confirmAll(s, [first.id]);
    const res = await s.approver(req(s));
    expect(res).toMatchObject({
      ok: false,
      error: { code: "budget.account_unconfirmed", details: { accountIds: [first.id] } },
    });
    expect(s.store.get("u1")!.cycle.state).toBe("draft");
    expect(s.published).toHaveLength(0);
  });

  it("rejects an unknown cycle", async () => {
    const s = await seeded();
    await ready(s);
    const res = await s.approver({ ...req(s), cycleId: "nope" });
    expect(res).toMatchObject({ ok: false, error: { code: "budget.cycle_not_found" } });
  });

  it("keeps awaiting_funds when the publish fails and re-emits once on retry", async () => {
    const s = await seeded();
    await ready(s);
    s.fail.publish = true;
    await expect(s.approver(req(s))).rejects.toThrow("bus down");
    expect(s.store.get("u1")!.cycle.state).toBe("awaiting_funds");
    s.fail.publish = false;
    expect((await s.approver(req(s))).ok).toBe(true);
    expect(s.published).toHaveLength(1);
    expect(s.store.get("u1")!.audit.filter((a) => a.action === "cycle_approved")).toHaveLength(1);
    expect(await s.approver(req(s))).toMatchObject({ ok: false });
    expect(s.published).toHaveLength(1);
  });
});

describe("buildFundRequests", () => {
  const acc = (id: string, code: string): BankAccount => ({
    id,
    name: id,
    code,
    kind: "spending",
    emailNotificationsConfirmed: true,
  });
  const cat = (bankAccountId: string, cycleLimitVnd: number): BudgetCategory =>
    ({ id: `c${cycleLimitVnd}${bankAccountId}`, bankAccountId, cycleLimitVnd }) as BudgetCategory;

  it.each([
    {
      name: "sums limits per account",
      accounts: [acc("a", "MAIN"), acc("b", "sav")],
      categories: [cat("a", 1_000_000), cat("a", 500_000), cat("b", 200_000)],
      expected: [
        { bankAccountId: "a", requiredVnd: 1_500_000, memo: "MW-F-C03-MAIN" },
        { bankAccountId: "b", requiredVnd: 200_000, memo: "MW-F-C03-SAV" },
      ],
    },
    {
      name: "skips accounts that hold no category",
      accounts: [acc("a", "MAIN"), acc("b", "SAV")],
      categories: [cat("a", 10)],
      expected: [{ bankAccountId: "a", requiredVnd: 10, memo: "MW-F-C03-MAIN" }],
    },
    {
      name: "keeps a zero-limit account that holds a category",
      accounts: [acc("a", "PEN")],
      categories: [cat("a", 0)],
      expected: [{ bankAccountId: "a", requiredVnd: 0, memo: "MW-F-C03-PEN" }],
    },
  ])("$name", ({ accounts, categories, expected }) => {
    expect(buildFundRequests({ sequence: 3, accounts, categories })).toEqual(expected);
  });
});
