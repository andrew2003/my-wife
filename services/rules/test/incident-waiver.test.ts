import { describe, expect, it } from "vitest";
import type { EventEnvelope, EventPayload } from "@my-wife/contracts";
import {
  DEFAULT_FAULT_SETTINGS,
  InMemoryFaultStore,
  createFaultService,
  findCoveringIncident,
  summarizeWaivedFaults,
  type IncidentWindow,
} from "../src/fault";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INC = "77777777-7777-4777-8777-777777777777";
const T0 = new Date("2026-11-26T03:00:00.000Z");
const iso = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const H = 3_600_000;

const win = (over: Partial<IncidentWindow> = {}): IncidentWindow => ({
  id: INC,
  state: "active",
  startsAt: iso(-H),
  endsAt: iso(H),
  scope: "all",
  ...over,
});

describe("findCoveringIncident", () => {
  const cases = [
    { name: "inside, scope all", w: win(), at: 0, user: USER, hit: true },
    { name: "exactly at start", w: win(), at: -H, user: USER, hit: true },
    { name: "exactly at end", w: win(), at: H, user: USER, hit: true },
    { name: "one ms before start", w: win(), at: -H - 1, user: USER, hit: false },
    { name: "one ms after end", w: win(), at: H + 1, user: USER, hit: false },
    {
      name: "open-ended incident covers later time",
      w: win({ endsAt: null }),
      at: 50 * H,
      user: USER,
      hit: true,
    },
    { name: "scope list with user", w: win({ scope: [USER] }), at: 0, user: USER, hit: true },
    { name: "scope list without user", w: win({ scope: [OTHER] }), at: 0, user: USER, hit: false },
    { name: "cancelled incident", w: win({ state: "cancelled" }), at: 0, user: USER, hit: false },
    {
      name: "declared (not yet active) still counts",
      w: win({ state: "declared" }),
      at: 0,
      user: USER,
      hit: true,
    },
    {
      name: "ended incident counts for its window",
      w: win({ state: "ended" }),
      at: 0,
      user: USER,
      hit: true,
    },
  ] as const;
  it.each(cases)("$name", ({ w, at, user, hit }) => {
    const r = findCoveringIncident(iso(at), user, [w]);
    expect(r?.id).toBe(hit ? INC : undefined);
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
const env = (p: Detected): EventEnvelope =>
  ({
    id: "44444444-4444-4444-8444-444444444444",
    type: "fault.detected",
    userId: USER,
    occurredAt: p.occurredAt,
    schemaVersion: 1,
    payload: p,
  }) as EventEnvelope;

function setup(incidents: IncidentWindow[], incidentWaiver = true) {
  const store = new InMemoryFaultStore();
  const events: EventEnvelope[] = [];
  let n = 0;
  const svc = createFaultService({
    store,
    publish: (e) => void events.push(e),
    listIncidents: async () => incidents,
    readSettings: async () => ({ ...DEFAULT_FAULT_SETTINGS, incidentWaiver }),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  return { svc, store, events };
}

describe("fault inside an admin incident", () => {
  it("becomes waived_system with cause admin_incident, audit and fault.waived", async () => {
    const { svc, store, events } = setup([win()]);
    const r = await svc.onFaultDetected(env(detected()), T0);
    expect(r.status).toBe("waived_system");
    expect(store.list(USER)[0]).toMatchObject({
      status: "waived_system",
      waiver: "admin_incident",
      systemCause: `incident:${INC}`,
    });
    expect(store.audit(USER).map((a) => a.action)).toEqual(["fault.waived_system"]);
    expect(events.map((e) => e.type)).toEqual(["fault.waived"]);
    expect(events[0]!.payload).toMatchObject({ cause: "admin_incident", kind: "system" });
  });

  it("outside the incident stays recorded", async () => {
    const { svc } = setup([win()]);
    const r = await svc.onFaultDetected(env(detected({ occurredAt: iso(2 * H) })), T0);
    expect(r.status).toBe("recorded");
  });

  it("is not waived when the user setting admin.incident_waiver_default is off", async () => {
    const { svc } = setup([win()], false);
    const r = await svc.onFaultDetected(env(detected()), T0);
    expect(r.status).toBe("recorded");
  });

  it("an outage overlap keeps its own cause", async () => {
    const { svc, store } = setup([win()]);
    await svc.onFaultDetected(env(detected({ overlapsOutage: true })), T0);
    expect(store.list(USER)[0]!.waiver).toBe("heartbeat_gap_outage");
  });
});

describe("summarizeWaivedFaults (weekly report)", () => {
  it("lists system-waived faults of the week with cause and points, excluding others", async () => {
    const { svc, store } = setup([win()]);
    await svc.onFaultDetected(env(detected({ signalRef: "a" })), T0);
    await svc.onFaultDetected(env(detected({ signalRef: "b", occurredAt: iso(5 * H) })), T0);
    await svc.onFaultDetected(env(detected({ signalRef: "c", occurredAt: iso(-30 * 24 * H) })), T0);
    const r = summarizeWaivedFaults(
      store.list(USER),
      new Date(iso(-24 * H)),
      new Date(iso(24 * H)),
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ cause: "admin_incident", type: "no_face", points: 2 });
    expect(r.totalPointsWaived).toBe(2);
  });
});
