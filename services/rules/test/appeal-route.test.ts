import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { OpenAppealResponseSchema, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryFaultStore } from "../src/fault";
import { InMemoryPenaltyStore } from "../src/penalty";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "11111111-1111-4111-8111-111111111111";
const FAULT = "33333333-3333-4333-8333-333333333333";
const PENALTY = "44444444-4444-4444-8444-444444444444";
const AT = "2026-11-26T03:00:00.000Z";

function setup() {
  const faultStore = new InMemoryFaultStore();
  const penaltyStore = new InMemoryPenaltyStore();
  faultStore.insertOnce(
    USER,
    {
      id: FAULT,
      type: "no_face",
      occurredAt: AT,
      signalRef: "s1",
      reasonRef: null,
      weightSnapshot: 2,
      points: 2,
      status: "recorded",
      waiver: null,
      systemCause: null,
      honestReason: false,
    },
    { id: "a", faultId: FAULT, action: "fault.recorded", at: AT, detail: {} },
  );
  penaltyStore.insertOnce(
    USER,
    {
      id: PENALTY,
      source: "monitoring",
      amountVnd: 20_000,
      status: "due",
      dueDate: AT,
      transferCode: "MW-PH-X",
      sourceKey: "k",
      auditRefs: [],
      issuedAt: AT,
      contractId: null,
    },
    { id: "p", penaltyId: PENALTY, action: "penalty.created", at: AT, detail: {} },
  );
  const events: EventEnvelope[] = [];
  const app = createApp(config, {
    faultStore,
    penaltyStore,
    now: () => new Date("2026-11-26T05:00:00.000Z"),
    publish: (e) => void events.push(e),
  });
  return { app, events };
}

describe("appeal routes", () => {
  it("opens an appeal, hides the reversed penalty after an accepted decision", async () => {
    const { app, events } = setup();
    const open = await app.inject({
      method: "POST",
      url: "/appeals",
      headers: { "x-user-id": USER },
      payload: {
        subjectKind: "fault",
        subjectId: FAULT,
        reasonText: "I was there",
        penaltyId: PENALTY,
      },
    });
    expect(open.statusCode).toBe(200);
    const parsed = OpenAppealResponseSchema.parse(open.json());
    if (!parsed.ok) throw new Error("expected ok");
    expect(events.map((e) => e.type)).toEqual(["appeal.opened"]);

    const decide = await app.inject({
      method: "POST",
      url: "/appeals/decide",
      headers: { "x-user-id": USER },
      payload: { appealId: parsed.data.appeal.id, outcome: "overturned" },
    });
    expect(decide.statusCode).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["appeal.opened", "fault.appeal_decided"]);
    const list = await app.inject({
      method: "GET",
      url: "/penalties",
      headers: { "x-user-id": USER },
    });
    expect(list.json().data.penalties).toEqual([]);
  });

  it("requires a user and a valid body, and answers 404 for an unknown appeal", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "POST", url: "/appeals", payload: {} })).statusCode).toBe(
      401,
    );
    const bad = await app.inject({
      method: "POST",
      url: "/appeals",
      headers: { "x-user-id": USER },
      payload: { subjectKind: "fault" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/appeals/decide",
      headers: { "x-user-id": USER },
      payload: { appealId: PENALTY, outcome: "upheld" },
    });
    expect(missing.statusCode).toBe(404);
  });
});
