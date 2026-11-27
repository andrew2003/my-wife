import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { ConsentKind, EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryAppealFrameStore } from "../src/appeal";
import { InMemoryFaultStore } from "../src/fault";
import { InMemoryPenaltyStore } from "../src/penalty";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "11111111-1111-4111-8111-111111111111";
const FAULT = "33333333-3333-4333-8333-333333333333";
const AT = "2026-11-26T03:00:00.000Z";
const headers = { "x-user-id": USER };

function setup(consents: ConsentKind[]) {
  const faultStore = new InMemoryFaultStore();
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
  const frames = new InMemoryAppealFrameStore();
  const events: EventEnvelope[] = [];
  const app = createApp(config, {
    faultStore,
    penaltyStore: new InMemoryPenaltyStore(),
    appealFrameStore: frames,
    hasConsent: async (_u, k) => consents.includes(k),
    now: () => new Date("2026-11-26T05:00:00.000Z"),
    publish: (e) => void events.push(e),
  });
  return { app, frames, events };
}

async function openAppeal(app: ReturnType<typeof setup>["app"]): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/appeals",
    headers,
    payload: { subjectKind: "fault", subjectId: FAULT, reasonText: "at my desk" },
  });
  return r.json().data.appeal.id as string;
}

describe("appeal frame route", () => {
  it("accepts a consented frame and deletes it on decision", async () => {
    const { app, frames, events } = setup(["vision_frame"]);
    const appealId = await openAppeal(app);
    const put = await app.inject({
      method: "POST",
      url: "/appeals/frame",
      headers,
      payload: { appealId, frameBase64: "ZnJhbWU=" },
    });
    expect(put.statusCode).toBe(200);
    expect(frames.has(USER, appealId)).toBe(true);
    await app.inject({
      method: "POST",
      url: "/appeals/decide",
      headers,
      payload: { appealId, outcome: "overturned" },
    });
    expect(frames.has(USER, appealId)).toBe(false);
    expect(events.map((e) => e.type)).toContain("fault.appeal_decided");
  });

  it("answers 403 without consent, 401 without a user and 400 for a bad body", async () => {
    const { app, frames } = setup([]);
    const appealId = await openAppeal(app);
    const send = (h: Record<string, string>, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/appeals/frame", headers: h, payload });
    expect((await send(headers, { appealId, frameBase64: "ZnJhbWU=" })).statusCode).toBe(403);
    expect(frames.has(USER, appealId)).toBe(false);
    expect((await send({}, {})).statusCode).toBe(401);
    expect((await send(headers, { appealId })).statusCode).toBe(400);
  });
});
