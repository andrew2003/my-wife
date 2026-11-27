import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import {
  InMemoryCycleContractStore,
  createCycleContractService,
  evaluateCycleContract,
  nextCycleStart,
} from "../src/cycle-contract";
import { InMemoryContractStore, createContractService } from "../src/contract";
import {
  computeEffectiveFrom,
  createRuleChangeService,
  InMemoryRuleChangeStore,
} from "../src/rule-change";

const USER = "11111111-1111-4111-8111-111111111111";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const CYCLE2 = "33333333-3333-4333-8333-333333333333";
const TZ = "Asia/Ho_Chi_Minh";

describe("nextCycleStart", () => {
  const rows = [
    {
      name: "4 weeks, local midnight",
      firstDay: "2026-11-02",
      weeks: 4,
      expected: "2026-11-29T17:00:00.000Z",
    },
    {
      name: "Sydney across DST start (UTC+11 from 2026-10-04 02:00)",
      firstDay: "2026-09-21",
      weeks: 2,
      tz: "Australia/Sydney",
      expected: "2026-10-04T13:00:00.000Z",
    },
    {
      name: "New York across DST end (UTC-5 after 2026-11-01)",
      firstDay: "2026-10-26",
      weeks: 2,
      tz: "America/New_York",
      expected: "2026-11-09T05:00:00.000Z",
    },
    {
      name: "UTC, 6 weeks",
      firstDay: "2026-11-02",
      weeks: 6,
      tz: "UTC",
      expected: "2026-12-14T00:00:00.000Z",
    },
    { name: "1 week", firstDay: "2026-11-02", weeks: 1, expected: "2026-11-08T17:00:00.000Z" },
    {
      name: "crosses a year",
      firstDay: "2026-12-14",
      weeks: 4,
      expected: "2027-01-10T17:00:00.000Z",
    },
  ];
  it.each(rows)("$name", ({ firstDay, weeks, expected, ...rest }) => {
    const tz = "tz" in rest ? (rest as { tz: string }).tz : TZ;
    expect(nextCycleStart(firstDay, weeks, tz).toISOString()).toBe(expected);
  });
});

describe("evaluateCycleContract", () => {
  const cycle = { cycleId: CYCLE, firstDay: "2026-11-02" };
  const rows = [
    {
      name: "new cycle without a signed contract requires one and locks loosening",
      signed: false,
      now: "2026-11-02T01:00:00.000Z",
      expected: { contractRequired: true, looseningLockedUntil: "2026-11-29T17:00:00.000Z" },
    },
    {
      name: "signed contract no longer required, lock stays",
      signed: true,
      now: "2026-11-10T01:00:00.000Z",
      expected: { contractRequired: false, looseningLockedUntil: "2026-11-29T17:00:00.000Z" },
    },
    {
      name: "one ms before the next cycle the lock holds",
      signed: true,
      now: "2026-11-29T16:59:59.999Z",
      expected: { contractRequired: false, looseningLockedUntil: "2026-11-29T17:00:00.000Z" },
    },
    {
      name: "an unsigned cycle that ended no longer reports a required contract",
      signed: false,
      now: "2026-11-29T17:00:00.000Z",
      expected: { contractRequired: false, looseningLockedUntil: null },
    },
    {
      name: "at the next cycle start the lock is over",
      signed: true,
      now: "2026-11-29T17:00:00.000Z",
      expected: { contractRequired: false, looseningLockedUntil: null },
    },
  ];
  it.each(rows)("$name", ({ signed, now, expected }) => {
    expect(
      evaluateCycleContract({ cycle, signed, cycleWeeks: 4, timeZone: TZ }, new Date(now)),
    ).toEqual(expected);
  });
});

describe("loosening lock in rule changes", () => {
  const base = {
    direction: "loosening" as const,
    scope: "next_cycle" as const,
    timeZone: TZ,
    weekStartDay: "monday" as const,
  };
  it("loosening waits for the cycle lock even when the next week is earlier", () => {
    const at = computeEffectiveFrom(
      { ...base, scope: "next_week", looseningLockedUntil: "2026-11-29T17:00:00.000Z" },
      new Date("2026-11-04T03:00:00.000Z"),
    );
    expect(at.toISOString()).toBe("2026-11-29T17:00:00.000Z");
  });
  it("tightening ignores the lock", () => {
    const now = new Date("2026-11-04T03:00:00.000Z");
    expect(
      computeEffectiveFrom(
        { ...base, direction: "tightening", looseningLockedUntil: "2026-11-29T17:00:00.000Z" },
        now,
      ),
    ).toEqual(now);
  });
  it("the rule change service stores the locked effective date", async () => {
    const events: EventEnvelope[] = [];
    const service = createRuleChangeService({
      store: new InMemoryRuleChangeStore(),
      publish: (e) => void events.push(e),
      readSettings: () => ({}),
      looseningLockedUntil: () => "2026-11-29T17:00:00.000Z",
    });
    const rec = await service.save(
      USER,
      { key: "penalty.weekly_cap_vnd", from: 200000, to: 100000 },
      new Date("2026-11-04T03:00:00.000Z"),
    );
    expect(rec.direction).toBe("loosening");
    expect(rec.effectiveFrom).toBe("2026-11-29T17:00:00.000Z");
  });
});

describe("cycle contract service", () => {
  function setup() {
    const contracts = new InMemoryContractStore();
    const signer = createContractService({
      store: contracts,
      now: () => new Date("2026-11-03T00:00:00.000Z"),
    });
    const service = createCycleContractService({
      store: new InMemoryCycleContractStore(),
      contracts,
      readSettings: () => ({ cycleWeeks: 4, timeZone: TZ }),
    });
    return { signer, service };
  }
  const opened = (cycleId: string, firstDay: string) => ({ cycleId, firstDay });

  it("a newly opened cycle needs a fresh contract even if the last cycle was signed", async () => {
    const { signer, service } = setup();
    await signer.sign(USER, CYCLE);
    service.onCycleOpened(USER, opened(CYCLE, "2026-11-02"));
    expect(service.status(USER, new Date("2026-11-03T01:00:00.000Z"))).toMatchObject({
      cycleId: CYCLE,
      contractRequired: false,
    });
    service.onCycleOpened(USER, opened(CYCLE2, "2026-11-30"));
    expect(service.status(USER, new Date("2026-11-30T01:00:00.000Z"))).toEqual({
      cycleId: CYCLE2,
      contractRequired: true,
      looseningLockedUntil: "2026-12-27T17:00:00.000Z",
    });
    await signer.sign(USER, CYCLE2);
    expect(service.status(USER, new Date("2026-11-30T02:00:00.000Z"))?.contractRequired).toBe(
      false,
    );
  });

  it("redelivery of cycle.opened changes nothing", () => {
    const { service } = setup();
    service.onCycleOpened(USER, opened(CYCLE, "2026-11-02"));
    service.onCycleOpened(USER, opened(CYCLE, "2026-11-02"));
    expect(service.status(USER, new Date("2026-11-03T01:00:00.000Z"))?.contractRequired).toBe(true);
  });

  it("an older cycle opened late never replaces a newer one", () => {
    const { service } = setup();
    service.onCycleOpened(USER, opened(CYCLE2, "2026-11-30"));
    service.onCycleOpened(USER, opened(CYCLE, "2026-11-02"));
    expect(service.status(USER, new Date("2026-11-30T01:00:00.000Z"))?.cycleId).toBe(CYCLE2);
  });

  it("the same first day with another cycle id keeps the first one seen", () => {
    const { service } = setup();
    service.onCycleOpened(USER, opened(CYCLE, "2026-11-02"));
    service.onCycleOpened(USER, opened(CYCLE2, "2026-11-02"));
    expect(service.status(USER, new Date("2026-11-03T01:00:00.000Z"))?.cycleId).toBe(CYCLE);
  });

  it("no cycle means no status", () => {
    expect(setup().service.status(USER, new Date())).toBeUndefined();
  });
});

describe("cycle contract routes", () => {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
  it("cycle.opened marks the contract required, GET /contracts/status reports it", async () => {
    const app = createApp(config, { now: () => new Date("2026-11-03T01:00:00.000Z") });
    const event = {
      id: "44444444-4444-4444-8444-444444444444",
      type: "cycle.opened",
      userId: USER,
      occurredAt: "2026-11-02T00:00:00.000Z",
      schemaVersion: 1,
      payload: { cycleId: CYCLE, sequence: 1, firstDay: "2026-11-02" },
    };
    const res = await app.inject({ method: "POST", url: "/events/cycle-opened", payload: event });
    expect(res.statusCode).toBe(200);
    const status = await app.inject({
      method: "GET",
      url: "/contracts/status",
      headers: { "x-user-id": USER },
    });
    expect(status.json().data).toMatchObject({ cycleId: CYCLE, contractRequired: true });
    const noUser = await app.inject({ method: "GET", url: "/contracts/status" });
    expect(noUser.statusCode).toBe(401);
    expect(status.json().data.looseningLockedUntil).toBe("2026-11-29T17:00:00.000Z");
    const signed = await app.inject({
      method: "POST",
      url: "/contracts/sign",
      headers: { "x-user-id": USER },
      payload: { cycleId: CYCLE },
    });
    expect(signed.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/contracts/status",
      headers: { "x-user-id": USER },
    });
    expect(after.json().data).toEqual({
      cycleId: CYCLE,
      contractRequired: false,
      looseningLockedUntil: "2026-11-29T17:00:00.000Z",
    });
    const bad = await app.inject({
      method: "POST",
      url: "/events/cycle-opened",
      payload: { x: 1 },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
