import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { DAY_MS } from "@my-wife/test-kit";
import { MONEY_USER, type MoneyWorld } from "./money-world";

/** Names the failing step: the first failing step is the one to reproduce. */
export async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`step failed: ${name}`, { cause: err });
  }
}

export const START = "2026-12-01T03:00:00.000Z";
/** Last digits of the three accounts of the sample budget (the budget account codes). */
export const TAIL = { spending: "1111", savings: "2222", penalty_savings: "9999" } as const;

/** A bank mail time: `day` whole days and `hourUtc` hours after 2026-12-01T00:00:00Z. */
export const at = (day: number, hourUtc: number) =>
  new Date(Date.parse("2026-12-01T00:00:00.000Z") + day * DAY_MS + hourUtc * 3_600_000);

/**
 * Brings a fresh world to a running cycle: the sample budget draft, the accounts confirmed by
 * test receipts, the contract signed (trial started), the cycle approved and every account
 * funded by a signed mail.
 */
export async function openRunningCycle(world: MoneyWorld): Promise<void> {
  await world.emit("onboarding.step_completed", { step: "qa_templates", skipped: true });
  const draft = await world.record();
  expect(draft.cycle.state).toBe("draft");
  for (const account of draft.accounts) {
    expect(
      await world.budgetStore.setAccountCode(
        MONEY_USER,
        account.id,
        TAIL[account.kind],
        world.clock.now(),
      ),
    ).toBe("ok");
  }
  let n = 0;
  for (const account of (await world.record()).accounts) {
    const res = await world.sendMail({
      kind: "credit",
      id: `confirm-${account.kind}`,
      amountVnd: 1_000,
      reference: `CONF000${++n}`,
      at: world.clock.now(),
      accountTail: TAIL[account.kind],
      memo: "test",
    });
    expect(res.status).toBe(200);
  }
  const signed = await world.signContract((await world.record()).cycle.id);
  expect(signed.statusCode).toBe(200);
  const contractId = (await signed.json()).data.contract.id;
  const approved = await world.approveCycle((await world.record()).cycle.id, contractId);
  expect(approved.statusCode).toBe(200);

  const requested = world.ofType("cycle.funds_requested")[0]!;
  const transfers = (
    requested.payload as {
      transfers: { bankAccountId: string; requiredVnd: number; memo: string }[];
    }
  ).transfers;
  const record = await world.record();
  for (const t of transfers) {
    const account = record.accounts.find((a) => a.id === t.bankAccountId)!;
    const res = await world.sendMail({
      kind: "credit",
      id: `fund-${account.kind}`,
      amountVnd: t.requiredVnd,
      reference: `FUND000${++n}`,
      at: world.clock.now(),
      accountTail: TAIL[account.kind],
      memo: t.memo,
    });
    expect(res.status).toBe(200);
  }
  expect((await world.record()).cycle.state).toBe("running");
}

/**
 * A `receipt.parsed` payload from a named merchant, as ingest would publish it. The ingest
 * templates do not read a counterparty yet (it is always null), so scenarios that need one (the
 * refund rule matches on it) publish the receipt directly.
 */
export function merchantReceipt(
  ref: string,
  direction: "in" | "out",
  amountVnd: number,
  memo: string,
  when: Date,
  counterparty = "Grab",
) {
  return {
    receiptId: randomUUID(),
    bankTransactionRef: ref,
    bankAccountHint: TAIL.spending,
    direction,
    amountVnd,
    currency: "VND",
    counterparty,
    memo,
    occurredAt: when.toISOString(),
    source: "parser",
    fxProvisional: false,
  };
}
