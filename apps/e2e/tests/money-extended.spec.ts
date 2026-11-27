import { afterAll, beforeAll, expect, it } from "vitest";
import { buildWeeklyLimitPlan, createCycleCloser } from "@my-wife/budget";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { DAY_MS } from "@my-wife/test-kit";
import { MONEY_USER, startMoneyWorld, type MoneyWorld } from "../support/money-world";
import { at, merchantReceipt, openRunningCycle, START, step, TAIL } from "../support/money-steps";

/**
 * Scenario 2, extended: the failure branches of the money flow and the appeal on simulated time.
 *
 * Forged mail, a planned transfer paid from the wrong bank, an unknown spend nobody answers (it
 * is booked by the deadline), a refund larger than its original, debts (a receivable written off
 * when it is overdue, a payable), three overspends of one week whose penalties are suspended by
 * the trial, two appeals (one overturned, one upheld), the trial settlement, and the surplus
 * split of the closing cycle.
 *
 * The scenario seeds trial.weeks = 1 and trial.final_appeal_hours = 0 like the happy path. Money
 * rules are decided by the services; this file only drives them (signed bank mails through the
 * real ingest webhook, the services' own routes, the simulated clock) and checks the outcome.
 * Its own bookkeeping of what was spent (`spent`) is kept apart from the services' totals, so
 * the surplus is checked against an independent sum.
 */
const TRIAL = { weeks: 1, installmentsK: 1, finalAppealHours: 0 } as const;
const pct = SETTINGS["penalty.overspend_percent"].default;
// Spec 12: penalty = excess x penalty.overspend_percent / 100. Every excess used below is a
// multiple of 100, so the division is exact and no rounding rule is repeated here.
const penaltyOf = (excessVnd: number) => (excessVnd * pct) / 100;

type PenaltyView = {
  id: string;
  source: string;
  amountVnd: number;
  status: string;
  transferCode: string;
};
type AppealView = { id: string; status: string };

let world: MoneyWorld;

beforeAll(async () => {
  world = await startMoneyWorld({ start: START, trial: TRIAL });
});
afterAll(async () => {
  await world.stop();
});

it("money, extended: failure branches, debts, appeals, trial settlement and surplus split", async () => {
  const category = async (shortCode: string) =>
    (await world.record()).categories.find((c) => c.shortCode === shortCode)!;
  const penalties = async () =>
    (
      (await world.call("rules", "GET", "/penalties")).body.data as {
        penalties: PenaltyView[];
      }
    ).penalties;
  /** What this scenario has spent per category short code, net of refunds. */
  const spent: Record<string, number> = {};
  const spend = (code: string, vnd: number) => {
    spent[code] = (spent[code] ?? 0) + vnd;
  };

  await step("a running cycle exists (draft, confirmed accounts, contract, funding)", async () => {
    await openRunningCycle(world);
    expect(world.ofType("cycle.opened")).toHaveLength(1);
  });

  await step(
    "forged mail: signed by the wrong key it is rejected and changes nothing",
    async () => {
      const before = {
        parsed: world.ofType("receipt.parsed").length,
        transactions: (await world.record()).transactions.length,
        penalties: (await penalties()).length,
      };
      const res = await world.sendForgedMail({
        kind: "credit",
        id: "forged-penalty-payment",
        amountVnd: 9_999_000,
        reference: "FORG0001",
        at: world.clock.now(),
        accountTail: TAIL.penalty_savings,
        memo: "Penalty payment",
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ ok: false, error: { code: "dkim_invalid" } });
      expect(world.ofType("receipt.rejected").at(-1)!.payload).toMatchObject({
        reason: "dkim_invalid",
      });
      expect(world.ofType("receipt.parsed")).toHaveLength(before.parsed);
      expect((await world.record()).transactions).toHaveLength(before.transactions);
      expect(await penalties()).toHaveLength(before.penalties);
    },
  );

  await step("wrong bank: a planned transfer paid from another account is flagged", async () => {
    const food = await category("AN");
    const published = await world.call("budget", "POST", "/budget/weekly-plan", {
      weekIndex: 1,
      items: [{ categoryId: food.id, amountVnd: 100_000 }],
    });
    expect(published.status).toBe(200);
    const [item] = (await world.record()).plannedItems;
    expect(item).toMatchObject({ categoryId: food.id, amountVnd: 100_000, status: "planned" });

    await world.clock.advanceBy(DAY_MS);
    // The amount matches the plan exactly: only the paying account is wrong (savings, not spending).
    const res = await world.sendMail({
      kind: "debit",
      id: "wrong-bank",
      amountVnd: 100_000,
      reference: "WRNG0001",
      at: at(1, 3),
      accountTail: TAIL.savings,
      memo: item!.transferCode,
    });
    expect(res.status).toBe(200);
    const txn = (await world.record()).transactions.find(
      (t) => t.bankTransactionRef === "WRNG0001",
    );
    expect(txn).toMatchObject({
      transactionType: "planned_transfer",
      reconciliationResult: "wrong_bank",
      categoryId: food.id,
      amountVnd: 100_000,
    });
    expect(world.ofType("txn.recorded").at(-1)!.payload).toMatchObject({
      reconciliationResult: "wrong_bank",
    });
    spend("AN", 100_000);
  });

  let unknownSpendVnd = 0;
  await step(
    "unknown timeout: nobody answers, the deadline books it to a want category",
    async () => {
      unknownSpendVnd = 120_000;
      const before = (await world.record()).transactions.length;
      world.expectUnknown({
        bankTransactionRef: "UNKN0001",
        bankAccountHint: TAIL.spending,
        amountVnd: unknownSpendVnd,
        occurredAt: at(1, 5).toISOString(),
        memo: "QR payment",
      });
      const res = await world.sendMail({
        kind: "debit",
        id: "spend-unknown-timeout",
        amountVnd: unknownSpendVnd,
        reference: "UNKN0001",
        at: at(1, 5),
        accountTail: TAIL.spending,
        memo: "QR payment",
        extraLabel: ["Channel", "QR"],
      });
      expect(res.body).toMatchObject({ ok: true, data: { state: "needs_confirmation" } });
      expect((await world.record()).transactions).toHaveLength(before);
      const ask = world.ofType("ask.budget_category").at(-1)!.payload as {
        questionId: string;
        expiresAt: string;
      };
      const asked = world.clock.now();
      expect(Date.parse(ask.expiresAt) - asked.getTime()).toBe(
        SETTINGS["budget.unknown_deadline_hours"].default * 3_600_000,
      );

      // Just before the deadline the job books nothing.
      await world.clock.advanceTo(new Date(Date.parse(ask.expiresAt) - 60_000));
      const early = await world.call("budget", "POST", "/jobs/unknown-deadline", {
        userId: MONEY_USER,
      });
      expect(early.body.data).toMatchObject({ booked: 0 });
      expect((await world.record()).transactions).toHaveLength(before);

      await world.clock.advanceTo(new Date(Date.parse(ask.expiresAt) + 60_000));
      const late = await world.call("budget", "POST", "/jobs/unknown-deadline", {
        userId: MONEY_USER,
      });
      expect(late.body.data).toMatchObject({ booked: 1 });
      // The first want category in the user's order with room.
      const firstWant = await category("AG");
      const booked = (await world.record()).transactions.find(
        (t) => t.bankTransactionRef === "UNKN0001",
      );
      expect(booked).toMatchObject({
        categoryId: firstWant.id,
        amountVnd: unknownSpendVnd,
        transactionType: "unknown",
      });
      expect(world.ofType("anomaly.resolved").at(-1)!.payload).toMatchObject({
        resolution: `deadline:category:${firstWant.id}`,
      });
      spend("AG", unknownSpendVnd);

      // A second run, and a late answer, book nothing more.
      const again = await world.call("budget", "POST", "/jobs/unknown-deadline", {
        userId: MONEY_USER,
      });
      expect(again.body.data).toMatchObject({ booked: 0 });
      await world.emit("notify.reply_received", {
        questionId: ask.questionId,
        sourceService: "budget",
        kind: "budget_category",
        value: (await category("DL")).id,
        answeredAt: world.clock.now().toISOString(),
        via: "chat",
      });
      expect(
        (await world.record()).transactions.filter((t) => t.bankTransactionRef === "UNKN0001"),
      ).toHaveLength(1);
    },
  );

  await step(
    "refund: more than the original restores the original and the excess is income",
    async () => {
      // The ingest templates do not read a counterparty yet, so the receipts are published as
      // ingest would once they do (the refund rule matches on the counterparty; see #374).
      await world.emit(
        "receipt.parsed",
        merchantReceipt("GRAB0001", "out", 140_000, "DL", at(3, 2)),
      );
      spend("DL", 140_000);
      const original = (await world.record()).transactions.find(
        (t) => t.bankTransactionRef === "GRAB0001",
      )!;
      expect(original.categoryId).toBe((await category("DL")).id);

      await world.emit(
        "receipt.parsed",
        merchantReceipt("GRAB0002", "in", 300_000, "Refund", at(3, 6)),
      );
      const refund = (await world.record()).transactions.find(
        (t) => t.bankTransactionRef === "GRAB0002",
      )!;
      expect(refund).toMatchObject({
        transactionType: "refund",
        refundOfTransactionId: original.id,
        restoredVnd: 140_000,
        categoryId: original.categoryId,
      });
      spend("DL", -140_000);
      const record = await world.record();
      expect(record.incomePool.map((e) => e.amountVnd)).toEqual([160_000]);
      expect(world.ofType("income.recorded")).toHaveLength(1);
      expect(world.ofType("income.recorded")[0]!.payload).toMatchObject({ amountVnd: 160_000 });
      // The same receipt delivered again books nothing twice.
      await world.emit(
        "receipt.parsed",
        merchantReceipt("GRAB0002", "in", 300_000, "Refund", at(3, 6)),
      );
      expect((await world.record()).incomePool).toHaveLength(1);
    },
  );

  let receivableId = "";
  await step("debts: a receivable and a payable are listed and announced", async () => {
    const contingency = await category("DP");
    const lend = await world.call("budget", "POST", "/budget/debts", {
      kind: "receivable",
      person: "Minh",
      amountVnd: 400_000,
      // Overdue by more than the prompt days when the week closes.
      dueAt: "2026-12-01T00:00:00.000Z",
      fundingCategoryId: contingency.id,
    });
    expect(lend.status).toBe(201);
    receivableId = (lend.body.data as { id: string }).id;
    const borrow = await world.call("budget", "POST", "/budget/debts", {
      kind: "payable",
      person: "Lan",
      amountVnd: 1_000_000,
      dueAt: null,
      fundingCategoryId: null,
    });
    expect(borrow.status).toBe(201);
    const list = (await world.call("budget", "GET", "/budget/debts")).body.data as {
      debts: {
        id: string;
        kind: string;
        person: string;
        amountVnd: number;
        settledVnd: number;
        state: string;
      }[];
    };
    expect(list.debts.map((d) => [d.kind, d.person, d.amountVnd, d.settledVnd, d.state])).toEqual([
      ["receivable", "Minh", 400_000, 0, "open"],
      ["payable", "Lan", 1_000_000, 0, "open"],
    ]);
    expect(world.ofType("debt.opened")).toHaveLength(2);
    // A payable is not income: nothing enters the income pool.
    expect((await world.record()).incomePool).toHaveLength(1);
    spend("DP", 0);
  });

  const excess = { AG: 100_000, GT: 60_000, MS: 40_000 } as const;
  await step("three want categories overspend in week 1", async () => {
    const record = await world.record();
    const plan = (code: keyof typeof excess) =>
      buildWeeklyLimitPlan({
        cycleLimitVnd: record.categories.find((c) => c.shortCode === code)!.cycleLimitVnd,
        weeks: record.cycle.weeks,
        roundingVnd: SETTINGS["budget.weekly_limit_rounding_vnd"].default,
      })[0]!;
    // AG already carries the unknown spend booked by the deadline.
    const amounts = {
      AG: plan("AG") + excess.AG - (spent.AG ?? 0),
      GT: plan("GT") + excess.GT,
      MS: plan("MS") + excess.MS,
    };
    expect(amounts.AG).toBeGreaterThan(0);
    let n = 0;
    for (const code of ["AG", "GT", "MS"] as const) {
      const res = await world.sendMail({
        kind: "debit",
        id: `over-${code}`,
        amountVnd: amounts[code],
        reference: `OVER000${++n}`,
        at: at(4, 3 + n),
        accountTail: TAIL.spending,
        memo: code,
      });
      expect(res.status).toBe(200);
      spend(code, amounts[code]);
    }
  });

  await step(
    "week 1 closes: debt written off, three overspends found, penalties suspended",
    async () => {
      // Schedule closes the week at its boundary, an hour before the trial ends.
      await world.clock.advanceTo("2026-12-08T02:00:00.000Z");
      const record = await world.record();
      await world.emit("week.closed", {
        weekId: "0190a0a0-0000-7000-8000-0000000000f2",
        firstDay: record.cycle.firstDay,
        weekIndexInCycle: 1,
      });

      // The overdue receivable became an expense of its funding category.
      const written = world.ofType("debt.written_off");
      expect(written).toHaveLength(1);
      expect(written[0]!.payload).toMatchObject({
        debtId: receivableId,
        amountVnd: 400_000,
        bookedToCategoryId: (await category("DP")).id,
      });
      const debts = (await world.call("budget", "GET", "/budget/debts")).body.data as {
        debts: { id: string; state: string }[];
      };
      expect(debts.debts.find((d) => d.id === receivableId)!.state).toBe("written_off");

      const detected = world.ofType("overspend.detected");
      const byCategory = new Map(
        detected.map((e) => [(e.payload as { categoryId: string }).categoryId, e.payload]),
      );
      expect([...byCategory.keys()].sort()).toEqual(
        (await Promise.all(["AG", "GT", "MS"].map(async (c) => (await category(c)).id))).sort(),
      );
      for (const code of ["AG", "GT", "MS"] as const) {
        expect(byCategory.get((await category(code)).id)).toMatchObject({
          excessVnd: excess[code],
        });
      }

      const list = await penalties();
      expect(list.map((p) => [p.source, p.amountVnd, p.status]).sort()).toEqual(
        (["AG", "GT", "MS"] as const)
          .map((c) => ["overspend", penaltyOf(excess[c]), "suspended"])
          .sort(),
      );
      expect(world.ofType("penalty.suspended")).toHaveLength(3);
      expect(world.types()).not.toContain("penalty.issued");
    },
  );

  let overturned: PenaltyView;
  let upheld: PenaltyView;
  let plain: PenaltyView;
  const appealIds: Record<string, string> = {};
  await step("two penalties are appealed inside the window and stay suspended", async () => {
    const list = await penalties();
    const find = (code: keyof typeof excess) =>
      list.find((p) => p.amountVnd === penaltyOf(excess[code]))!;
    overturned = find("AG");
    upheld = find("MS");
    plain = find("GT");
    const detected = world.ofType("overspend.detected");
    for (const [code, p] of [
      ["AG", overturned],
      ["MS", upheld],
    ] as const) {
      const catId = (await category(code)).id;
      const subject = detected.find(
        (e) => (e.payload as { categoryId: string }).categoryId === catId,
      )!;
      const res = await world.call("rules", "POST", "/appeals", {
        // Contracts have no overspend subject kind; a penalty is appealed as a classification.
        subjectKind: "classification",
        subjectId: subject.id,
        reasonText: `Appeal of the ${code} overspend`,
        penaltyId: p.id,
      });
      expect(res.status).toBe(200);
      const appeal = (res.body.data as { appeal: AppealView }).appeal;
      expect(appeal.status).toBe("open");
      appealIds[code] = appeal.id;
      // The same penalty cannot be appealed twice.
      const again = await world.call("rules", "POST", "/appeals", {
        subjectKind: "classification",
        subjectId: subject.id,
        reasonText: "again",
        penaltyId: p.id,
      });
      expect(again.status).toBe(409);
    }
    expect(world.ofType("appeal.opened")).toHaveLength(2);
    for (const p of await penalties()) expect(p.status).toBe("suspended");
  });

  await step(
    "trial settlement: the trial ends, only the penalty without an appeal falls due",
    async () => {
      expect(world.types()).not.toContain("trial.ended");
      await world.clock.advanceTo("2026-12-08T05:00:00.000Z");
      expect(world.types().filter((t) => t === "trial.ended" || t === "trial.settled")).toEqual([
        "trial.ended",
        "trial.settled",
      ]);
      const settled = world.ofType("trial.settled")[0]!.payload as { totalVnd: number };
      expect(settled.totalVnd).toBe(plain.amountVnd);
      const byAmount = new Map((await penalties()).map((p) => [p.amountVnd, p.status]));
      expect(byAmount.get(plain.amountVnd)).toBe("due");
      // Held by their appeals: not settled, not due.
      expect(byAmount.get(overturned.amountVnd)).toBe("suspended");
      expect(byAmount.get(upheld.amountVnd)).toBe("suspended");
    },
  );

  await step(
    "appeal decisions: overturned reverses the penalty, upheld lets it fall due",
    async () => {
      const decide = (code: string, outcome: "overturned" | "upheld") =>
        world.call("rules", "POST", "/appeals/decide", {
          appealId: appealIds[code],
          outcome,
          note: `decided ${outcome}`,
        });
      const a = await decide("AG", "overturned");
      expect(a.status).toBe(200);
      expect((a.body.data as { appeal: AppealView }).appeal.status).toBe("overturned");
      const b = await decide("MS", "upheld");
      expect(b.status).toBe(200);
      expect((b.body.data as { appeal: AppealView }).appeal.status).toBe("upheld");
      // Decided once.
      expect((await decide("AG", "upheld")).status).toBe(409);

      // The reversed penalty leaves the ledger at once; the upheld one is settled by the next run.
      expect((await penalties()).map((p) => p.id)).not.toContain(overturned.id);
      await world.clock.advanceBy(2 * 3_600_000);
      const after = new Map((await penalties()).map((p) => [p.id, p.status]));
      expect(after.get(upheld.id)).toBe("due");
      expect(after.get(plain.id)).toBe("due");
      expect(after.size).toBe(2);
      // The settled total of the trial was published once and is not repeated.
      expect(world.ofType("trial.settled")).toHaveLength(1);

      // Audit trail: the penalty ledger records the reversal and the release with the appeal id.
      // The decision event exists for fault appeals only, and the appeal's own audit (with the
      // decision note) has no read route, so neither is asserted here.
      const audit = world.penaltyStore.audit(MONEY_USER);
      expect(
        audit.find((r) => r.penaltyId === overturned.id && r.action === "penalty.reversed"),
      ).toMatchObject({ detail: { appealId: appealIds.AG, outcome: "overturned" } });
      expect(
        audit.find((r) => r.penaltyId === upheld.id && r.action === "penalty.appeal_released"),
      ).toMatchObject({ detail: { appealId: appealIds.MS, outcome: "upheld" } });
    },
  );

  await step(
    "a transfer with the code pays the upheld penalty; the reversed one cannot be paid",
    async () => {
      // A transfer with the reversed penalty's code pays nothing.
      const reversedTry = await world.sendMail({
        kind: "credit",
        id: "pay-reversed",
        amountVnd: overturned.amountVnd,
        reference: "PAYP0001",
        at: world.clock.now(),
        accountTail: TAIL.penalty_savings,
        memo: overturned.transferCode,
      });
      expect(reversedTry.status).toBe(200);
      expect(world.ofType("penalty.paid")).toHaveLength(0);
      const reversed = world.penaltyStore.list(MONEY_USER).find((p) => p.id === overturned.id)!;
      expect(reversed.reversedAt).toBeDefined();
      expect(reversed.status).not.toBe("paid");

      const res = await world.sendMail({
        kind: "credit",
        id: "pay-upheld",
        amountVnd: upheld.amountVnd,
        reference: "PAYP0002",
        at: world.clock.now(),
        accountTail: TAIL.penalty_savings,
        memo: upheld.transferCode,
      });
      expect(res.status).toBe(200);
      const after = new Map((await penalties()).map((p) => [p.id, p.status]));
      expect(after.get(upheld.id)).toBe("paid");
      expect(after.get(plain.id)).toBe("due");
      expect(world.ofType("penalty.paid")).toHaveLength(1);
    },
  );

  await step("surplus split: the closing cycle splits the sum of positive remainders", async () => {
    const record = await world.record();
    // Independent sum: limit minus what this scenario spent, per variable category that counts.
    const expectedTotal = record.categories
      .filter((c) => c.countsTowardSurplus && c.kind === "variable")
      .reduce((sum, c) => sum + Math.max(0, c.cycleLimitVnd - (spent[c.shortCode] ?? 0)), 0);
    expect(expectedTotal).toBeGreaterThan(0);

    // Nothing in the services moves a cycle from running to closing yet, so the scenario puts
    // the cycle there and drives the closing step itself on the real store (see #373).
    // TODO(#373): replace with the real running -> closing trigger.
    world.budgetStore.get(MONEY_USER)!.cycle.state = "closing";
    const close = createCycleCloser({
      store: world.budgetStore,
      now: () => world.clock.now(),
      publish: (event: EventEnvelope) => world.publish(event),
    });
    const result = await close(MONEY_USER);
    expect(result.ok).toBe(true);
    const savings = Math.floor(
      (expectedTotal * SETTINGS["budget.surplus_share_savings_percent"].default) / 100,
    );
    const future = Math.floor(
      (expectedTotal * SETTINGS["budget.surplus_share_future_purchases_percent"].default) / 100,
    );
    const allocation = world.ofType("surplus.allocated")[0]!.payload as Record<string, unknown>;
    expect(allocation).toMatchObject({
      cycleId: record.cycle.id,
      totalVnd: expectedTotal,
      savingsVnd: savings,
      futurePurchasesVnd: future,
      remainderVnd: expectedTotal - savings - future,
      remainderTarget: SETTINGS["budget.surplus_remainder_target"].default,
    });
    // Penalties never count toward the surplus: the penalty ledger is not part of the sum.
    expect(world.ofType("cycle.closed")).toHaveLength(1);
    expect((await world.record()).cycle.state).toBe("closed");

    // Closing again repeats nothing.
    expect((await close(MONEY_USER)).ok).toBe(true);
    expect(world.ofType("surplus.allocated")).toHaveLength(1);
    expect(world.ofType("cycle.closed")).toHaveLength(1);
  });
});

it("money, refund of the spec example: the refund restores the category before the week closes", async () => {
  // Known failing until #372 is fixed.
  // Spec 10, acceptance 7: a refund of 300,000 against an original of 200,000 restores 200,000
  // to the category and 100,000 is income. The original is above the weekly limit of the
  // category (150,000), so only the refund keeps the week from counting as an overspend.
  const refundWorld = await startMoneyWorld({ start: START, trial: TRIAL });
  try {
    await step("a running cycle exists and the original is above the weekly limit", async () => {
      await openRunningCycle(refundWorld);
      const record = await refundWorld.record();
      const dl = record.categories.find((c) => c.shortCode === "DL")!;
      const [weekly] = buildWeeklyLimitPlan({
        cycleLimitVnd: dl.cycleLimitVnd,
        weeks: record.cycle.weeks,
        roundingVnd: SETTINGS["budget.weekly_limit_rounding_vnd"].default,
      });
      expect(200_000).toBeGreaterThan(weekly!);
    });
    await step("the refund restores 200,000 and 100,000 is income", async () => {
      await refundWorld.emit(
        "receipt.parsed",
        merchantReceipt("SPEC0001", "out", 200_000, "DL", at(3, 2)),
      );
      await refundWorld.emit(
        "receipt.parsed",
        merchantReceipt("SPEC0002", "in", 300_000, "Refund", at(3, 6)),
      );
      const record = await refundWorld.record();
      const refund = record.transactions.find((t) => t.bankTransactionRef === "SPEC0002");
      expect(refund).toMatchObject({ transactionType: "refund", restoredVnd: 200_000 });
      expect(record.incomePool.map((e) => e.amountVnd)).toEqual([100_000]);
    });
    await step("the week closes without an overspend for the fully refunded category", async () => {
      await refundWorld.clock.advanceTo("2026-12-08T00:00:00.000Z");
      const record = await refundWorld.record();
      await refundWorld.emit("week.closed", {
        weekId: "0190a0a0-0000-7000-8000-0000000000f3",
        firstDay: record.cycle.firstDay,
        weekIndexInCycle: 1,
      });
      expect(refundWorld.ofType("overspend.detected")).toHaveLength(0);
      expect(refundWorld.penaltyStore.list(MONEY_USER)).toHaveLength(0);
    });
  } finally {
    await refundWorld.stop();
  }
});
