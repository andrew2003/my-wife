import { describe, expect, it } from "vitest";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import {
  computeTrialEnd,
  createTrialService,
  InMemoryTrialStore,
  settleTrial,
  type SuspendedEntry,
} from "../src/trial";

const USER = "11111111-1111-4111-8111-111111111111";
const CONTRACT = "33333333-3333-4333-8333-333333333333";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-11-26T03:00:00.000Z");
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}
const entry = (id: string, amountVnd: number): SuspendedEntry => ({
  id,
  source: "monitoring",
  amountVnd,
});
const signed = (): EventEnvelope =>
  ({
    id: "44444444-4444-4444-8444-444444444444",
    type: "contract.signed",
    userId: USER,
    occurredAt: T0.toISOString(),
    schemaVersion: 1,
    payload: { contractId: CONTRACT, cycleId: CYCLE, version: 1 },
  }) as EventEnvelope;

function setup(
  settings: Partial<{ weeks: number; installmentsK: number; finalAppealHours: number }> = {},
) {
  const events: EventEnvelope[] = [];
  const store = new InMemoryTrialStore();
  const service = createTrialService({
    store,
    publish: (e) => void events.push(e),
    newId: ids(),
    readSettings: async () => ({
      weeks: settings.weeks ?? SETTINGS["trial.weeks"].default,
      installmentsK: settings.installmentsK ?? SETTINGS["trial.installments_k"].default,
      finalAppealHours: settings.finalAppealHours ?? SETTINGS["trial.final_appeal_hours"].default,
    }),
  });
  const types = () => events.map((e) => e.type);
  return { events, store, service, types };
}

describe("computeTrialEnd", () => {
  const cases = [
    { name: "default weeks", weeks: 4, end: "2026-12-24T03:00:00.000Z" },
    { name: "one week", weeks: 1, end: "2026-12-03T03:00:00.000Z" },
  ];
  it.each(cases)("$name", ({ weeks, end }) => {
    expect(computeTrialEnd(T0, weeks).toISOString()).toBe(end);
  });
});

describe("settleTrial", () => {
  const at = T0;
  const week = (n: number) => new Date(at.getTime() + n * WEEK).toISOString();
  const cases = [
    {
      name: "single payment keeps the whole amount due at settle time",
      entries: [entry("a", 50_000)],
      k: 1,
      expected: [{ entryId: "a", installments: [{ amountVnd: 50_000, dueDate: week(0) }] }],
    },
    {
      name: "three equal installments one week apart",
      entries: [entry("a", 60_000)],
      k: 3,
      expected: [
        {
          entryId: "a",
          installments: [
            { amountVnd: 20_000, dueDate: week(0) },
            { amountVnd: 20_000, dueDate: week(1) },
            { amountVnd: 20_000, dueDate: week(2) },
          ],
        },
      ],
    },
    {
      name: "remainder goes to the last installment so the total is exact",
      entries: [entry("a", 20_001)],
      k: 2,
      expected: [
        {
          entryId: "a",
          installments: [
            { amountVnd: 10_000, dueDate: week(0) },
            { amountVnd: 10_001, dueDate: week(1) },
          ],
        },
      ],
    },
    { name: "no entries gives no schedule", entries: [], k: 3, expected: [] },
  ];
  it.each(cases)("$name", ({ entries, k, expected }) => {
    expect(settleTrial({ entries, installmentsK: k, settledAt: at })).toEqual(expected);
  });
});

describe("trial lifecycle", () => {
  it("emits trial.started once on contract.signed, ending trial.weeks later", async () => {
    const { events, service } = setup();
    await service.onContractSigned(signed(), T0);
    await service.onContractSigned(signed(), T0);
    const started = events.filter((e) => e.type === "trial.started");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toEqual({
      weeks: 4,
      installmentsK: 1,
      endsAt: computeTrialEnd(T0, 4).toISOString(),
    });
  });

  it("a later contract of another cycle does not restart the trial", async () => {
    const { types, service } = setup();
    await service.onContractSigned(signed(), T0);
    await service.onContractSigned(signed(), new Date(T0.getTime() + 5 * WEEK));
    expect(types()).toEqual(["trial.started"]);
  });

  it("does nothing before the trial end", async () => {
    const { types, service } = setup();
    await service.onContractSigned(signed(), T0);
    await service.runJob(new Date(T0.getTime() + 4 * WEEK - 1));
    expect(types()).toEqual(["trial.started"]);
  });

  it("emits trial.ended once at the end and opens the final appeal window", async () => {
    const { events, store, service } = setup();
    await service.onContractSigned(signed(), T0);
    store.addSuspended(USER, [entry("a", 30_000), entry("b", 20_000)]);
    const end = computeTrialEnd(T0, 4);
    await service.runJob(end);
    await service.runJob(new Date(end.getTime() + HOUR));
    const ended = events.filter((e) => e.type === "trial.ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.payload).toEqual({
      reason: "elapsed",
      suspendedTotalVnd: 50_000,
      finalAppealEndsAt: new Date(end.getTime() + 72 * HOUR).toISOString(),
    });
    expect(events.some((e) => e.type === "trial.settled")).toBe(false);
  });

  it("settles after the appeal window: entries become due, trial.settled once", async () => {
    const { events, store, service } = setup({ installmentsK: 2 });
    await service.onContractSigned(signed(), T0);
    store.addSuspended(USER, [entry("a", 30_000), entry("b", 20_001)]);
    const end = computeTrialEnd(T0, 4);
    await service.runJob(end);
    const appealEnd = new Date(end.getTime() + 72 * HOUR);
    await service.runJob(new Date(appealEnd.getTime() - 1));
    expect(store.entries(USER).every((e) => e.status === "suspended")).toBe(true);
    await service.runJob(appealEnd);
    await service.runJob(new Date(appealEnd.getTime() + HOUR));
    expect(store.entries(USER).map((e) => [e.id, e.status, e.installments.length])).toEqual([
      ["a", "due", 2],
      ["b", "due", 2],
    ]);
    const settled = events.filter((e) => e.type === "trial.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toEqual({ totalVnd: 50_001, installmentsK: 2 });
  });

  it("entries under an open appeal stay suspended and are not settled", async () => {
    const { store, service, events } = setup();
    await service.onContractSigned(signed(), T0);
    store.addSuspended(USER, [entry("a", 30_000), { ...entry("b", 20_000), appealOpen: true }]);
    await service.runJob(new Date(T0.getTime() + 100 * WEEK));
    expect(store.entries(USER).map((e) => e.status)).toEqual(["due", "suspended"]);
    expect(events.find((e) => e.type === "trial.settled")!.payload).toMatchObject({
      totalVnd: 30_000,
    });
  });

  it("trial.weeks = 1 and final_appeal_hours = 0: ended and settled in the same run", async () => {
    const { types, store, service } = setup({ weeks: 1, finalAppealHours: 0 });
    await service.onContractSigned(signed(), T0);
    store.addSuspended(USER, [entry("a", 10_000)]);
    await service.runJob(new Date(T0.getTime() + WEEK + 1));
    expect(types()).toEqual(["trial.started", "trial.ended", "trial.settled"]);
    expect(store.entries(USER)[0]!.status).toBe("due");
  });

  it("retries an event whose publish failed without duplicating the others", async () => {
    const events: EventEnvelope[] = [];
    let fail = true;
    const service = createTrialService({
      store: new InMemoryTrialStore(),
      publish: (e) => {
        if (e.type === "trial.ended" && fail) throw new Error("bus down");
        events.push(e);
      },
      newId: ids(),
      readSettings: async () => ({ weeks: 1, installmentsK: 1, finalAppealHours: 0 }),
    });
    await service.onContractSigned(signed(), T0);
    const later = new Date(T0.getTime() + 2 * WEEK);
    await service.runJob(later);
    fail = false;
    await service.runJob(later);
    await service.runJob(later);
    expect(events.map((e) => e.type)).toEqual(["trial.started", "trial.ended", "trial.settled"]);
  });
});
