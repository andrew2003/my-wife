import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import {
  DEFAULT_FAULT_SETTINGS,
  InMemoryFaultStore,
  createFaultService,
  type FaultSettings,
} from "../src/fault";
import { createApp } from "../src/app";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INC = "77777777-7777-4777-8777-777777777777";
const T0 = new Date("2026-11-26T03:00:00.000Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(T0.getTime() + ms).toISOString();

function detected(userId: string, signalRef: string, at: number): EventEnvelope {
  return {
    id: `44444444-4444-4444-8444-${signalRef.padStart(12, "0")}`,
    type: "fault.detected",
    userId,
    occurredAt: iso(at),
    schemaVersion: 1,
    payload: {
      signalRef,
      type: "no_face",
      occurredAt: iso(at),
      reason: "none",
      reasonRef: null,
      reasonKind: null,
      overlapsOutage: false,
    },
  } as EventEnvelope;
}

function incident(type: string, payload: Record<string, unknown>, eventId = "55"): EventEnvelope {
  return {
    id: `55555555-5555-4555-8555-${eventId.padStart(12, "0")}`,
    type,
    userId: "00000000-0000-4000-8000-000000000000",
    occurredAt: T0.toISOString(),
    schemaVersion: 1,
    payload,
  } as EventEnvelope;
}

const declared = (over: Record<string, unknown> = {}, eventId = "55") =>
  incident(
    "incident.declared",
    { incidentId: INC, startsAt: iso(-H), endsAt: iso(H), scope: "all", ...over },
    eventId,
  );

function setup(settings: FaultSettings = DEFAULT_FAULT_SETTINGS) {
  const store = new InMemoryFaultStore();
  const events: EventEnvelope[] = [];
  let n = 0;
  const svc = createFaultService({
    store,
    publish: (e) => void events.push(e),
    readSettings: async () => settings,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  return { svc, store, events };
}

async function seed(svc: ReturnType<typeof setup>["svc"]) {
  await svc.onFaultDetected(detected(USER, "1", 0), T0); // inside
  await svc.onFaultDetected(detected(USER, "2", -H), T0); // at start
  await svc.onFaultDetected(detected(USER, "3", 2 * H), T0); // after end
  await svc.onFaultDetected(detected(USER, "4", -2 * H), T0); // before start
  await svc.onFaultDetected(detected(OTHER, "5", 0), T0); // other user, inside
}

const statuses = (store: InMemoryFaultStore, user: string) =>
  store.list(user).map((f) => [f.signalRef, f.status]);

describe("incident.declared waives overlapping recorded faults", () => {
  const userInside = [
    ["1", "waived_system"],
    ["2", "waived_system"],
    ["3", "recorded"],
    ["4", "recorded"],
  ];
  const cases = [
    {
      name: "scope all waives every user's faults inside the window",
      scope: "all" as const,
      expectUser: userInside,
      expectOther: [["5", "waived_system"]],
    },
    {
      name: "scope list waives only the listed users",
      scope: [USER],
      expectUser: userInside,
      expectOther: [["5", "recorded"]],
    },
  ];
  it.each(cases)("$name", async ({ scope, expectUser, expectOther }) => {
    const { svc, store } = setup();
    await seed(svc);
    await svc.onIncidentEvent(declared({ scope }), T0);
    expect(statuses(store, USER)).toEqual(expectUser);
    expect(statuses(store, OTHER)).toEqual(expectOther);
  });

  it("records cause, audit and emits fault.waived", async () => {
    const { svc, store, events } = setup();
    await seed(svc);
    events.length = 0;
    const r = await svc.onIncidentEvent(declared({ scope: [USER] }), T0);
    expect(r.waived).toBe(2);
    expect(store.list(USER)[0]).toMatchObject({
      status: "waived_system",
      waiver: "admin_incident",
      systemCause: `incident:${INC}`,
    });
    expect(store.audit(USER).filter((a) => a.action === "fault.waived_system")).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["fault.waived", "fault.waived"]);
    expect(events[0]!.payload).toMatchObject({ cause: "admin_incident", kind: "system" });
  });

  it("an open-ended incident waives every fault from its start", async () => {
    const { svc, store } = setup();
    await seed(svc);
    await svc.onIncidentEvent(declared({ endsAt: null, scope: [USER] }), T0);
    expect(statuses(store, USER)).toEqual([
      ["1", "waived_system"],
      ["2", "waived_system"],
      ["3", "waived_system"],
      ["4", "recorded"],
    ]);
  });

  it("does nothing when the user setting admin.incident_waiver_default is off", async () => {
    const { svc, store } = setup({ ...DEFAULT_FAULT_SETTINGS, incidentWaiver: false });
    await seed(svc);
    await svc.onIncidentEvent(declared(), T0);
    expect(store.list(USER).every((f) => f.status === "recorded")).toBe(true);
  });

  it("a fault detected later inside the known incident is waived at detection", async () => {
    const { svc, store } = setup();
    await svc.onIncidentEvent(declared(), T0);
    await svc.onFaultDetected(detected(USER, "9", 0), T0);
    expect(statuses(store, USER)).toEqual([["9", "waived_system"]]);
  });
});

describe("incident.ended and incident.cancelled", () => {
  it("ended moves the end: later detections outside it stay recorded", async () => {
    const { svc, store } = setup();
    await svc.onIncidentEvent(declared({ endsAt: null, scope: [USER] }), T0);
    await svc.onIncidentEvent(
      incident("incident.ended", { incidentId: INC, endsAt: iso(H) }, "56"),
      T0,
    );
    await svc.onFaultDetected(detected(USER, "8", 3 * H), T0);
    await svc.onFaultDetected(detected(USER, "7", 0), T0);
    expect(statuses(store, USER)).toEqual([
      ["8", "recorded"],
      ["7", "waived_system"],
    ]);
  });

  it("cancelled incident no longer waives new faults", async () => {
    const { svc, store } = setup();
    await svc.onIncidentEvent(declared(), T0);
    await svc.onIncidentEvent(incident("incident.cancelled", { incidentId: INC }, "57"), T0);
    await svc.onFaultDetected(detected(USER, "9", 0), T0);
    expect(statuses(store, USER)).toEqual([["9", "recorded"]]);
  });

  it("ended or cancelled for an unknown incident is ignored", async () => {
    const { svc } = setup();
    const a = await svc.onIncidentEvent(
      incident("incident.ended", { incidentId: INC, endsAt: iso(H) }),
      T0,
    );
    const b = await svc.onIncidentEvent(incident("incident.cancelled", { incidentId: INC }), T0);
    expect([a.waived, b.waived]).toEqual([0, 0]);
  });
});

describe("redelivery", () => {
  it("consuming the same event again is a no-op", async () => {
    const { svc, store, events } = setup();
    await seed(svc);
    const first = await svc.onIncidentEvent(declared(), T0);
    const ledger = JSON.stringify(store.list(USER));
    const auditCount = store.audit(USER).length + store.audit(OTHER).length;
    const eventCount = events.length;
    const second = await svc.onIncidentEvent(declared(), new Date(T0.getTime() + H));
    expect(first.waived).toBe(3);
    expect(second.waived).toBe(0);
    expect(JSON.stringify(store.list(USER))).toBe(ledger);
    expect(store.audit(USER).length + store.audit(OTHER).length).toBe(auditCount);
    expect(events).toHaveLength(eventCount);
  });
});

describe("POST /events/incident", () => {
  it("rejects a non-incident event", async () => {
    const app = createApp(config, {});
    const res = await app.inject({
      method: "POST",
      url: "/events/incident",
      payload: detected(USER, "1", 0),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("waives through the route", async () => {
    const store = new InMemoryFaultStore();
    const app = createApp(config, { faultStore: store, now: () => T0 });
    await app.inject({
      method: "POST",
      url: "/events/fault-detected",
      payload: detected(USER, "1", 0),
    });
    const res = await app.inject({ method: "POST", url: "/events/incident", payload: declared() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.waived).toBe(1);
    expect(store.list(USER)[0]!.status).toBe("waived_system");
    await app.close();
  });
});
