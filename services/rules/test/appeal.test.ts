import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createAppealService, InMemoryAppealStore, type AppealSettings } from "../src/appeal";
import { InMemoryFaultStore, type FaultLedgerEntry } from "../src/fault";
import { InMemoryPenaltyStore, type PenaltyLedgerEntry } from "../src/penalty";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const FAULT = "33333333-3333-4333-8333-333333333333";
const PENALTY = "44444444-4444-4444-8444-444444444444";
const MISSING = "55555555-5555-4555-8555-555555555555";
const ISSUED = new Date("2026-11-26T03:00:00.000Z");
const hours = (h: number) => new Date(ISSUED.getTime() + h * 3_600_000);

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function setup(
  settings: AppealSettings = { windowHours: 24 },
  status: "due" | "suspended" = "due",
) {
  const faultStore = new InMemoryFaultStore();
  const penaltyStore = new InMemoryPenaltyStore();
  const events: EventEnvelope[] = [];
  const fault: FaultLedgerEntry = {
    id: FAULT,
    type: "tab_away",
    occurredAt: ISSUED.toISOString(),
    signalRef: "sig-1",
    reasonRef: null,
    weightSnapshot: 2,
    points: 2,
    status: "recorded",
    waiver: null,
    systemCause: null,
    honestReason: false,
  };
  faultStore.insertOnce(USER, fault, {
    id: "a0",
    faultId: FAULT,
    action: "fault.recorded",
    at: ISSUED.toISOString(),
    detail: {},
  });
  const penalty: PenaltyLedgerEntry = {
    id: PENALTY,
    source: "monitoring",
    amountVnd: 20_000,
    status,
    dueDate: hours(24 * 7).toISOString(),
    transferCode: "MW-PH-X",
    sourceKey: "weekly:1",
    auditRefs: [],
    issuedAt: ISSUED.toISOString(),
    contractId: null,
  };
  penaltyStore.insertOnce(USER, penalty, {
    id: "p0",
    penaltyId: PENALTY,
    action: "penalty.created",
    at: ISSUED.toISOString(),
    detail: {},
  });
  const service = createAppealService({
    store: new InMemoryAppealStore(),
    faultStore,
    penaltyStore,
    readSettings: async () => settings,
    publish: (e) => void events.push(e),
    newId: ids(),
  });
  return { service, faultStore, penaltyStore, events };
}

const request = { subjectKind: "fault" as const, subjectId: FAULT, penaltyId: PENALTY };

describe("open an appeal", () => {
  it("emits appeal.opened and suspends the penalty until decided", async () => {
    const { service, penaltyStore, faultStore, events } = setup();
    const r = await service.open(USER, { ...request, reasonText: "I was at my desk" }, hours(2));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appeal).toMatchObject({
      status: "open",
      windowEndsAt: hours(24).toISOString(),
      openedAt: hours(2).toISOString(),
    });
    const opened = events.filter((e) => e.type === "appeal.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.payload).toEqual({
      appealId: r.appeal.id,
      subjectKind: "fault",
      subjectId: FAULT,
    });
    expect(penaltyStore.list(USER)[0]!.appealId).toBe(r.appeal.id);
    expect(faultStore.list(USER)[0]!.status).toBe("appealed");
    expect(penaltyStore.audit(USER).map((a) => a.action)).toContain("penalty.appeal_hold");
  });

  it("keeps a held penalty from being marked due", async () => {
    const { service, penaltyStore } = setup(undefined, "suspended");
    await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    const audit = {
      id: "z",
      penaltyId: PENALTY,
      action: "penalty.due" as const,
      at: "",
      detail: {},
    };
    expect(penaltyStore.markDue(USER, PENALTY, hours(100).toISOString(), audit)).toBeUndefined();
  });

  it.each([
    ["at the end of the window", 24, 24, true],
    ["one hour after the window", 24, 25, false],
    ["custom 48 hour window, hour 40", 48, 40, true],
    ["custom 2 hour window, hour 3", 2, 3, false],
  ])("window: %s", async (_n, windowHours, at, ok) => {
    const { service, events } = setup({ windowHours });
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(at));
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.error).toBe("rules.appeal_window_closed");
    expect(events.some((e) => e.type === "appeal.opened")).toBe(ok);
  });

  it.each([
    ["empty reason", { ...request, reasonText: "  " }, USER, "rules.invalid_appeal"],
    [
      "unknown fault",
      { ...request, subjectId: MISSING, reasonText: "x" },
      USER,
      "rules.subject_not_found",
    ],
    ["another user", { ...request, reasonText: "x" }, OTHER, "rules.subject_not_found"],
    [
      "unknown penalty",
      { ...request, penaltyId: MISSING, reasonText: "x" },
      USER,
      "rules.subject_not_found",
    ],
  ])("rejects: %s", async (_n, body, user, code) => {
    const { service, events } = setup();
    const r = await service.open(user, body, hours(1));
    expect(r).toEqual({ ok: false, error: code });
    expect(events).toHaveLength(0);
  });

  it("rejects a second appeal on the same subject", async () => {
    const { service } = setup();
    await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    const r = await service.open(USER, { ...request, reasonText: "again" }, hours(2));
    expect(r).toEqual({ ok: false, error: "rules.appeal_already_open" });
  });

  it("falls back to the registry window when the setting is invalid", async () => {
    const { service } = setup({ windowHours: -3 });
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(23));
    expect(r.ok).toBe(true);
  });
});

describe("decide an appeal", () => {
  it("accepted: emits fault.appeal_decided and reverses the penalty", async () => {
    const { service, penaltyStore, faultStore, events } = setup();
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    if (!r.ok) throw new Error("open failed");
    const d = await service.decide(
      USER,
      r.appeal.id,
      "overturned",
      hours(5),
      "heartbeat proves it",
    );
    expect(d).toMatchObject({ ok: true, appeal: { status: "overturned" } });
    const decided = events.filter((e) => e.type === "fault.appeal_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toEqual({
      appealId: r.appeal.id,
      faultId: FAULT,
      outcome: "overturned",
    });
    expect(penaltyStore.list(USER)[0]!.reversedAt).toBe(hours(5).toISOString());
    expect(faultStore.list(USER)[0]!.status).toBe("overturned");
    expect(penaltyStore.audit(USER).map((a) => a.action)).toContain("penalty.reversed");
  });

  it("rejected: the fault stays upheld and the penalty is released, not reversed", async () => {
    const { service, penaltyStore, faultStore, events } = setup();
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    if (!r.ok) throw new Error("open failed");
    await service.decide(USER, r.appeal.id, "upheld", hours(5));
    const p = penaltyStore.list(USER)[0]!;
    expect(p.appealId).toBeUndefined();
    expect(p.reversedAt).toBeUndefined();
    expect(faultStore.list(USER)[0]!.status).toBe("upheld");
    expect(events.find((e) => e.type === "fault.appeal_decided")!.payload).toMatchObject({
      outcome: "upheld",
    });
  });

  it("decides once, and only for the owner", async () => {
    const { service, events } = setup();
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    if (!r.ok) throw new Error("open failed");
    expect(await service.decide(OTHER, r.appeal.id, "overturned", hours(2))).toEqual({
      ok: false,
      error: "rules.appeal_not_found",
    });
    await service.decide(USER, r.appeal.id, "overturned", hours(2));
    expect(await service.decide(USER, r.appeal.id, "upheld", hours(3))).toEqual({
      ok: false,
      error: "rules.appeal_already_decided",
    });
    expect(events.filter((e) => e.type === "fault.appeal_decided")).toHaveLength(1);
  });

  it("a failed publish is retried with the same event id and never decides twice", async () => {
    let fail = true;
    const events: EventEnvelope[] = [];
    const base = setup();
    const service = createAppealService({
      store: new InMemoryAppealStore(),
      faultStore: base.faultStore,
      penaltyStore: base.penaltyStore,
      publish: (e) => {
        if (fail) throw new Error("bus down");
        events.push(e);
      },
      newId: ids(),
    });
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(0);
    fail = false;
    await service.retryPending(USER, hours(2));
    await service.retryPending(USER, hours(3));
    expect(events.map((e) => e.type)).toEqual(["appeal.opened"]);
  });
});

describe("penalty must derive from the appealed fault", () => {
  it.each([
    ["an overspend penalty", { source: "overspend" as const, issuedAt: hours(1) }],
    ["a penalty issued before the fault", { source: "monitoring" as const, issuedAt: hours(-1) }],
    [
      "a penalty issued a month after the fault",
      { source: "routine" as const, issuedAt: hours(24 * 30) },
    ],
  ])("rejects %s", async (_n, other) => {
    const { service, penaltyStore, faultStore, events } = setup();
    const id = "66666666-6666-4666-8666-666666666666";
    penaltyStore.insertOnce(
      USER,
      {
        id,
        source: other.source,
        amountVnd: 10_000,
        status: "due",
        dueDate: hours(100).toISOString(),
        transferCode: "MW-PH-Y",
        sourceKey: "other",
        auditRefs: [],
        issuedAt: other.issuedAt.toISOString(),
        contractId: null,
      },
      { id: "p9", penaltyId: id, action: "penalty.created", at: "", detail: {} },
    );
    const r = await service.open(USER, { ...request, penaltyId: id, reasonText: "x" }, hours(2));
    expect(r).toEqual({ ok: false, error: "rules.penalty_not_from_fault" });
    expect(faultStore.list(USER)[0]!.status).toBe("recorded");
    expect(penaltyStore.list(USER).find((p) => p.id === id)!.appealId).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});

describe("atomic open", () => {
  it("a failed penalty hold leaves the fault appealable", async () => {
    const base = setup();
    const failing = Object.create(base.penaltyStore) as typeof base.penaltyStore;
    failing.holdForAppeal = () => undefined;
    const service = createAppealService({
      store: new InMemoryAppealStore(),
      faultStore: base.faultStore,
      penaltyStore: failing,
      newId: ids(),
    });
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    expect(r.ok).toBe(false);
    expect(base.faultStore.list(USER)[0]!.status).toBe("recorded");
    expect(service.list(USER)).toHaveLength(0);
    const retry = await base.service.open(USER, { ...request, reasonText: "x" }, hours(1));
    expect(retry.ok).toBe(true);
  });

  it("a failed fault transition releases the penalty hold", async () => {
    const base = setup();
    const failing = Object.create(base.faultStore) as typeof base.faultStore;
    failing.transition = () => undefined;
    const service = createAppealService({
      store: new InMemoryAppealStore(),
      faultStore: failing,
      penaltyStore: base.penaltyStore,
      newId: ids(),
    });
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    expect(r).toEqual({ ok: false, error: "rules.subject_not_appealable" });
    expect(base.penaltyStore.list(USER)[0]!.appealId).toBeUndefined();
    expect(service.list(USER)).toHaveLength(0);
  });
});

describe("decide checks the fault state", () => {
  it("rejects the decision when the fault is no longer appealed", async () => {
    const { service, faultStore, penaltyStore, events } = setup();
    const r = await service.open(USER, { ...request, reasonText: "x" }, hours(1));
    if (!r.ok) throw new Error("open failed");
    faultStore.transition(USER, FAULT, ["appealed"], "waived_system", {
      id: "w",
      faultId: FAULT,
      action: "fault.waived_system",
      at: hours(2).toISOString(),
      detail: {},
    });
    const d = await service.decide(USER, r.appeal.id, "overturned", hours(3));
    expect(d).toEqual({ ok: false, error: "rules.fault_not_appealed" });
    expect(service.list(USER)[0]!.status).toBe("open");
    expect(penaltyStore.list(USER)[0]!.reversedAt).toBeUndefined();
    expect(events.some((e) => e.type === "fault.appeal_decided")).toBe(false);
  });
});
