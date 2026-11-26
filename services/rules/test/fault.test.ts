import { describe, expect, it } from "vitest";
import { SETTINGS, type EventEnvelope, type EventPayload } from "@my-wife/contracts";
import {
  DEFAULT_FAULT_SETTINGS,
  InMemoryFaultStore,
  createFaultService,
  scoreFault,
  type FaultSettings,
} from "../src/fault";

const USER = "11111111-1111-4111-8111-111111111111";
const REASON = "55555555-5555-4555-8555-555555555555";
const T0 = new Date("2026-11-26T03:00:00.000Z");
const DAY = 86_400_000;

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

describe("DEFAULT_FAULT_SETTINGS", () => {
  it("is read from the settings registry, not re-typed", () => {
    expect(DEFAULT_FAULT_SETTINGS.weights.no_face).toBe(SETTINGS["fault.weight.no_face"].default);
    expect(DEFAULT_FAULT_SETTINGS.honestPercent).toBe(
      SETTINGS["fault.reason_multiplier_percent.honest"].default,
    );
    expect(DEFAULT_FAULT_SETTINGS.quotaPerWeek).toBe(SETTINGS["reason.quota_per_week"].default);
  });
});

describe("scoreFault (defaults table)", () => {
  const cases = [
    { name: "heartbeat_lost silent", type: "heartbeat_lost", reason: "none", points: 3 },
    { name: "heartbeat_lost honest", type: "heartbeat_lost", reason: "honest", points: 2 },
    {
      name: "heartbeat_lost quota exceeded",
      type: "heartbeat_lost",
      reason: "quota_exceeded",
      points: 3,
    },
    { name: "camera_off silent", type: "camera_off", reason: "none", points: 3 },
    { name: "camera_off honest", type: "camera_off", reason: "honest", points: 2 },
    { name: "no_face silent", type: "no_face", reason: "none", points: 2 },
    { name: "no_face honest", type: "no_face", reason: "honest", points: 1 },
    { name: "no_face quota exceeded", type: "no_face", reason: "quota_exceeded", points: 2 },
    { name: "tab_away silent", type: "tab_away", reason: "none", points: 1 },
    { name: "tab_away honest rounds half up", type: "tab_away", reason: "honest", points: 1 },
    { name: "wake_late silent", type: "wake_late", reason: "none", points: 2 },
    { name: "wake_late honest", type: "wake_late", reason: "honest", points: 1 },
    { name: "bedtime_missed silent", type: "bedtime_missed", reason: "none", points: 1 },
    { name: "bedtime_missed honest", type: "bedtime_missed", reason: "honest", points: 1 },
  ] as const;
  it.each(cases)("$name", ({ type, reason, points }) => {
    const r = scoreFault({ type, reason }, DEFAULT_FAULT_SETTINGS);
    expect(r.points).toBe(points);
    expect(r.weightSnapshot).toBe(DEFAULT_FAULT_SETTINGS.weights[type]);
  });

  it("follows user settings", () => {
    const s: FaultSettings = {
      ...DEFAULT_FAULT_SETTINGS,
      weights: { ...DEFAULT_FAULT_SETTINGS.weights, camera_off: 10 },
      honestPercent: 30,
    };
    expect(scoreFault({ type: "camera_off", reason: "honest" }, s).points).toBe(3);
    expect(scoreFault({ type: "camera_off", reason: "none" }, s).points).toBe(10);
  });
  it("zero weight scores zero", () => {
    const s = {
      ...DEFAULT_FAULT_SETTINGS,
      weights: { ...DEFAULT_FAULT_SETTINGS.weights, no_face: 0 },
    };
    expect(scoreFault({ type: "no_face", reason: "none" }, s).points).toBe(0);
  });
});

type Detected = EventPayload<"fault.detected">;
const detected = (over: Partial<Detected> = {}): Detected => ({
  signalRef: "sig-1",
  type: "no_face",
  occurredAt: T0.toISOString(),
  reason: "none",
  reasonRef: null,
  reasonKind: null,
  overlapsOutage: false,
  ...over,
});
const given = (over: Partial<Detected> = {}): Detected =>
  detected({ reason: "given", reasonRef: REASON, reasonKind: "water", ...over });
const env = (payload: Detected, id = "44444444-4444-4444-8444-444444444444"): EventEnvelope =>
  ({
    id,
    type: "fault.detected",
    userId: USER,
    occurredAt: payload.occurredAt,
    schemaVersion: 1,
    payload,
  }) as EventEnvelope;

function setup(opts: { settings?: FaultSettings; failPublish?: boolean } = {}) {
  const events: EventEnvelope[] = [];
  const store = new InMemoryFaultStore();
  const reads: Date[] = [];
  const state = { fail: opts.failPublish ?? false };
  const svc = createFaultService({
    store,
    newId: ids(),
    readSettings: async (_u, at) => {
      reads.push(at);
      return opts.settings ?? DEFAULT_FAULT_SETTINGS;
    },
    publish: async (e) => {
      if (state.fail) throw new Error("bus down");
      events.push(e);
    },
  });
  return { svc, store, events, reads, state };
}

describe("onFaultDetected", () => {
  it("records a silent fault: ledger entry, audit record and fault.recorded", async () => {
    const { svc, store, events } = setup();
    const r = await svc.onFaultDetected(env(detected()), T0);
    expect(r.status).toBe("recorded");
    const entries = store.list(USER);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "no_face",
      signalRef: "sig-1",
      weightSnapshot: 2,
      points: 2,
      status: "recorded",
      waiver: null,
      systemCause: null,
    });
    expect(store.audit(USER).map((a) => a.action)).toEqual(["fault.recorded"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "fault.recorded",
      payload: {
        faultId: entries[0]!.id,
        type: "no_face",
        points: 2,
        occurredAt: T0.toISOString(),
      },
    });
  });

  it("scores a given reason with the honest multiplier", async () => {
    const { svc, store } = setup();
    await svc.onFaultDetected(env(given()), T0);
    expect(store.list(USER)[0]).toMatchObject({ points: 1, reasonRef: REASON });
  });

  it("treats a reason beyond the weekly quota as silent", async () => {
    const { svc, store } = setup();
    for (const i of [1, 2, 3, 4]) {
      const at = new Date(T0.getTime() + i * 1000).toISOString();
      await svc.onFaultDetected(env(given({ signalRef: `s${i}`, occurredAt: at }), `id-${i}`), T0);
    }
    expect(store.list(USER).map((e) => e.points)).toEqual([1, 1, 1, 2]);
  });

  it("quota counts only the same type within the last 7 days", async () => {
    const { svc, store } = setup({ settings: { ...DEFAULT_FAULT_SETTINGS, quotaPerWeek: 1 } });
    const at = (d: number) => new Date(T0.getTime() + d * DAY).toISOString();
    await svc.onFaultDetected(env(given({ signalRef: "a", occurredAt: at(0) }), "e1"), T0);
    await svc.onFaultDetected(
      env(given({ signalRef: "b", type: "tab_away", occurredAt: at(1) }), "e2"),
      T0,
    );
    await svc.onFaultDetected(env(given({ signalRef: "c", occurredAt: at(8) }), "e3"), T0);
    expect(store.list(USER).map((e) => e.points)).toEqual([1, 1, 1]);
  });

  it("a quota-exceeded fault is silent even beyond the quota boundary of one", async () => {
    const { svc, store } = setup({ settings: { ...DEFAULT_FAULT_SETTINGS, quotaPerWeek: 1 } });
    const at = (d: number) => new Date(T0.getTime() + d * DAY).toISOString();
    await svc.onFaultDetected(env(given({ signalRef: "a", occurredAt: at(0) }), "e1"), T0);
    await svc.onFaultDetected(env(given({ signalRef: "b", occurredAt: at(1) }), "e2"), T0);
    expect(store.list(USER).map((e) => e.points)).toEqual([1, 2]);
  });

  it("marks a fault overlapping an outage waived_system, with no fault.recorded", async () => {
    const { svc, store, events } = setup();
    const r = await svc.onFaultDetected(
      env(detected({ type: "heartbeat_lost", overlapsOutage: true })),
      T0,
    );
    expect(r.status).toBe("waived_system");
    expect(store.list(USER)[0]).toMatchObject({
      status: "waived_system",
      waiver: "heartbeat_gap_outage",
      systemCause: "overlaps_outage",
    });
    expect(store.audit(USER).map((a) => a.action)).toEqual(["fault.waived_system"]);
    expect(events.map((e) => e.type)).toEqual(["fault.waived"]);
  });

  it("scores with the settings in force at occurred_at (point-in-time)", async () => {
    const { svc, reads } = setup();
    const occurred = new Date("2026-11-20T01:00:00.000Z");
    await svc.onFaultDetected(env(detected({ occurredAt: occurred.toISOString() })), T0);
    expect(reads).toEqual([occurred]);
  });

  it("is idempotent: same event twice gives one entry, one audit row, one event", async () => {
    const { svc, store, events } = setup();
    const e = env(detected());
    await svc.onFaultDetected(e, T0);
    const r = await svc.onFaultDetected(e, T0);
    expect(r.duplicate).toBe(true);
    expect(store.list(USER)).toHaveLength(1);
    expect(store.audit(USER)).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("is idempotent per signal even with a new event id", async () => {
    const { svc, store } = setup();
    await svc.onFaultDetected(env(detected()), T0);
    await svc.onFaultDetected(env(detected(), "99999999-9999-4999-8999-999999999999"), T0);
    expect(store.list(USER)).toHaveLength(1);
  });

  it("retries the owed event after a publish failure without a second entry", async () => {
    const { svc, store, events, state } = setup({ failPublish: true });
    await svc.onFaultDetected(env(detected()), T0);
    expect(events).toHaveLength(0);
    state.fail = false;
    await svc.onFaultDetected(env(detected()), T0);
    expect(store.list(USER)).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["fault.recorded"]);
    await svc.onFaultDetected(env(detected()), T0);
    expect(events).toHaveLength(1);
  });

  it("returned ledger entries are frozen snapshots", async () => {
    const { svc, store } = setup();
    await svc.onFaultDetected(env(detected()), T0);
    expect(() => {
      (store.list(USER)[0] as { points: number }).points = 99;
    }).toThrow();
  });
});
