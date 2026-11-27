import { afterAll, beforeAll, expect, it } from "vitest";
import { buildWeeklyLimitPlan } from "@my-wife/budget";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { DAY_MS } from "@my-wife/test-kit";
import { MONEY_USER, startMoneyWorld, type MoneyWorld } from "../support/money-world";

/**
 * Scenario 2: the money happy path on simulated time.
 *
 * Funding opens the cycle, a coded spend, an unknown spend and a foreign card payment are
 * booked once each, an overspend closes a week as a penalty that is suspended because the
 * trial is running, the trial ends and settles, the penalty becomes due and a transfer pays it.
 *
 * The scenario seeds trial.weeks = 1 and trial.final_appeal_hours = 0, so the trial ends one
 * week after the contract is signed and the final appeal window is closed at once.
 *
 * Money rules are decided by the services; this file only drives them with signed bank mails
 * through the real ingest webhook and checks the outcome. Chat is emulated by publishing the
 * answer a user would tap (`notify.reply_received`).
 */
/** Names the failing step: the first failing step is the one to reproduce. */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`step failed: ${name}`, { cause: err });
  }
}

const START = "2026-12-01T03:00:00.000Z";
const TRIAL = { weeks: 1, installmentsK: 1, finalAppealHours: 0 } as const;
// Bank mail times are local (UTC+7); these fall inside week 1 of the cycle (UTC days).
const at = (day: number, hourUtc: number) =>
  new Date(Date.parse("2026-12-01T00:00:00.000Z") + day * DAY_MS + hourUtc * 3_600_000);

const TAIL = { spending: "1111", savings: "2222", penalty_savings: "9999" } as const;

let world: MoneyWorld;

beforeAll(async () => {
  world = await startMoneyWorld({ start: START, trial: TRIAL });
});
afterAll(async () => {
  await world.stop();
});

it("money: funding, coded spend, unknown spend, card payment, overspend, suspended penalty, payment", async () => {
  const category = async (shortCode: string) => {
    const record = await world.record();
    return record.categories.find((c) => c.shortCode === shortCode)!;
  };
  const balanceSpent = async (shortCode: string) => {
    const record = await world.record();
    const c = record.categories.find((x) => x.shortCode === shortCode)!;
    return record.transactions
      .filter((t) => t.categoryId === c.id && t.direction === "out")
      .reduce((sum, t) => sum + t.amountVnd, 0);
  };

  await step(
    "the sample budget draft exists and the accounts are confirmed by test receipts",
    async () => {
      await world.emit("onboarding.step_completed", { step: "qa_templates", skipped: true });
      const record = await world.record();
      expect(record.cycle.state).toBe("draft");
      for (const account of record.accounts) {
        const tail = TAIL[account.kind];
        expect(
          await world.budgetStore.setAccountCode(MONEY_USER, account.id, tail, world.clock.now()),
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
      expect((await world.record()).accounts.every((a) => a.emailNotificationsConfirmed)).toBe(
        true,
      );
    },
  );

  await step(
    "signing the contract starts the trial; approving the cycle requests the funds",
    async () => {
      const record = await world.record();
      const signed = await world.signContract(record.cycle.id);
      expect(signed.statusCode).toBe(200);
      const contractId = (await signed.json()).data.contract.id;
      expect(world.types()).toContain("trial.started");
      const trial = world.trialStore.find(MONEY_USER)!;
      expect(Date.parse(trial.endsAt) - Date.parse(trial.startedAt)).toBe(7 * DAY_MS);

      const approved = await world.approveCycle(record.cycle.id, contractId);
      expect(approved.statusCode).toBe(200);
      expect((await world.record()).cycle.state).toBe("awaiting_funds");
      expect(world.types()).toContain("cycle.funds_requested");
    },
  );

  await step("funding every account opens the cycle once", async () => {
    const requested = world.ofType("cycle.funds_requested")[0]!;
    const transfers = (
      requested.payload as {
        transfers: { bankAccountId: string; requiredVnd: number; memo: string }[];
      }
    ).transfers;
    expect(transfers.length).toBeGreaterThan(0);
    const record = await world.record();
    let n = 0;
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
    expect(world.ofType("cycle.opened")).toHaveLength(1);
  });

  await step("a coded spend is booked in its category", async () => {
    await world.clock.advanceBy(DAY_MS);
    const res = await world.sendMail({
      kind: "debit",
      id: "spend-food",
      amountVnd: 150_000,
      reference: "SPND0001",
      at: at(1, 3),
      accountTail: TAIL.spending,
      memo: "AN",
    });
    expect(res.status).toBe(200);
    expect(await balanceSpent("AN")).toBe(150_000);
    const txn = world.ofType("txn.recorded").at(-1)!;
    expect(txn.payload).toMatchObject({ amountVnd: 150_000, transactionType: "coded_unplanned" });
  });

  await step("an unknown spend asks for a category and is booked on the answer", async () => {
    const before = (await world.record()).transactions.length;
    world.expectUnknown({
      bankTransactionRef: "SPND0002",
      bankAccountHint: TAIL.spending,
      amountVnd: 80_000,
      occurredAt: at(1, 5).toISOString(),
      memo: "QR payment",
    });
    const res = await world.sendMail({
      kind: "debit",
      id: "spend-unknown",
      amountVnd: 80_000,
      reference: "SPND0002",
      at: at(1, 5),
      accountTail: TAIL.spending,
      memo: "QR payment",
      extraLabel: ["Channel", "QR"],
    });
    expect(res.body).toMatchObject({ ok: true, data: { state: "needs_confirmation" } });
    // Nothing is booked before the answer.
    expect((await world.record()).transactions).toHaveLength(before);
    const ask = world.ofType("ask.budget_category").at(-1)!;
    const question = ask.payload as { questionId: string; options: { value: string }[] };
    const transport = await category("DL");
    expect(question.options.map((o) => o.value)).toContain(transport.id);

    await world.emit("notify.reply_received", {
      questionId: question.questionId,
      sourceService: "budget",
      kind: "budget_category",
      value: transport.id,
      answeredAt: world.clock.now().toISOString(),
      via: "chat",
    });
    expect(await balanceSpent("DL")).toBe(80_000);
    expect(world.types()).toContain("anomaly.resolved");
  });

  await step("a foreign card payment is booked once, from the debit", async () => {
    const authorization = await world.sendMail({
      kind: "card_authorization",
      id: "card-auth",
      foreignAmount: "9.99 USD",
      reference: "CARD0001",
      at: at(2, 1),
      accountTail: TAIL.spending,
      authCode: "A12345",
      merchant: "GOOGLE*YouTube",
    });
    expect(authorization.status).toBe(200);
    // The authorization has no final VND amount: it is held and books nothing.
    expect(await balanceSpent("AN")).toBe(150_000);
    const debit = await world.sendMail({
      kind: "card_debit",
      id: "card-debit",
      amountVnd: 250_000,
      foreignAmount: "9.99 USD",
      reference: "CARD0002",
      at: at(2, 19),
      accountTail: TAIL.spending,
      authCode: "A12345",
      merchant: "GOOGLE*YouTube",
      memo: "AN",
    });
    expect(debit.status).toBe(200);
    expect(await balanceSpent("AN")).toBe(150_000 + 250_000);
    const parsed = world
      .ofType("receipt.parsed")
      .filter((e) => (e.payload as { merchant?: string }).merchant);
    expect(parsed).toHaveLength(1);
  });

  let excessVnd = 0;
  await step("overspending a want category is found when the week closes", async () => {
    const record = await world.record();
    const eatingOut = await category("AG");
    const plan = buildWeeklyLimitPlan({
      cycleLimitVnd: eatingOut.cycleLimitVnd,
      weeks: record.cycle.weeks,
      roundingVnd: SETTINGS["budget.weekly_limit_rounding_vnd"].default,
    });
    excessVnd = 100_000;
    const res = await world.sendMail({
      kind: "debit",
      id: "spend-over",
      amountVnd: plan[0]! + excessVnd,
      reference: "SPND0003",
      at: at(3, 4),
      accountTail: TAIL.spending,
      memo: "AG",
    });
    expect(res.status).toBe(200);

    // Schedule closes week 1 at the week boundary, before the trial ends.
    await world.clock.advanceTo("2026-12-08T00:00:00.000Z");
    await world.emit("week.closed", {
      weekId: "0190a0a0-0000-7000-8000-0000000000f2",
      firstDay: record.cycle.firstDay,
      weekIndexInCycle: 1,
    });
    const detected = world.ofType("overspend.detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]!.payload).toMatchObject({
      categoryId: eatingOut.id,
      weeklyLimitVnd: plan[0],
      excessVnd,
    });
  });

  let penaltyVnd = 0;
  await step("the penalty is suspended while the trial runs and asks for no payment", async () => {
    penaltyVnd = Math.floor((excessVnd * SETTINGS["penalty.overspend_percent"].default + 50) / 100);
    const [entry] = world.penaltyStore.list(MONEY_USER);
    expect(entry).toMatchObject({
      source: "overspend",
      amountVnd: penaltyVnd,
      status: "suspended",
    });
    expect(world.types()).toContain("penalty.suspended");
    expect(world.types()).not.toContain("penalty.issued");
  });

  await step(
    "simulated time passes the trial end: trial.ended and trial.settled follow",
    async () => {
      expect(world.types()).not.toContain("trial.ended");
      await world.clock.advanceTo("2026-12-08T05:00:00.000Z");
      const order = world.types().filter((t) => t === "trial.ended" || t === "trial.settled");
      expect(order).toEqual(["trial.ended", "trial.settled"]);
      const settled = world.ofType("trial.settled")[0]!.payload as { totalVnd: number };
      expect(settled.totalVnd).toBe(penaltyVnd);
    },
  );

  await step("the suspended penalty is due before it is paid", async () => {
    const [entry] = world.penaltyStore.list(MONEY_USER);
    expect(entry!.status).toBe("due");
  });

  await step(
    "a transfer with the penalty code to the penalty savings account pays it",
    async () => {
      const [entry] = world.penaltyStore.list(MONEY_USER);
      const res = await world.sendMail({
        kind: "credit",
        id: "penalty-payment",
        amountVnd: entry!.amountVnd,
        reference: "PAYP0001",
        at: world.clock.now(),
        accountTail: TAIL.penalty_savings,
        memo: entry!.transferCode,
      });
      expect(res.status).toBe(200);
      const [paid] = world.penaltyStore.list(MONEY_USER);
      expect(paid!.status).toBe("paid");
      const event = world.ofType("penalty.paid")[0] as EventEnvelope<"penalty.paid">;
      expect(event.payload).toMatchObject({ penaltyId: paid!.id, amountVnd: penaltyVnd });
    },
  );
});
