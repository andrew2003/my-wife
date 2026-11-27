import { describe, expect, it } from "vitest";
import type { ConsentKind, EventEnvelope } from "@my-wife/contracts";
import {
  createAppealService,
  InMemoryAppealFrameStore,
  InMemoryAppealStore,
  type AppealFrameStore,
} from "../src/appeal";
import { InMemoryFaultStore } from "../src/fault";
import { InMemoryPenaltyStore } from "../src/penalty";

const USER = "11111111-1111-4111-8111-111111111111";
const FAULT = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2026-11-26T03:00:00.000Z");
const later = (h: number) => new Date(AT.getTime() + h * 3_600_000);

function setup(consents: ConsentKind[] = ["vision_frame"], frames?: AppealFrameStore) {
  const faultStore = new InMemoryFaultStore();
  faultStore.insertOnce(
    USER,
    {
      id: FAULT,
      type: "no_face",
      occurredAt: AT.toISOString(),
      signalRef: "s1",
      reasonRef: null,
      weightSnapshot: 2,
      points: 2,
      status: "recorded",
      waiver: null,
      systemCause: null,
      honestReason: false,
    },
    { id: "a", faultId: FAULT, action: "fault.recorded", at: AT.toISOString(), detail: {} },
  );
  const events: EventEnvelope[] = [];
  const frameStore = frames ?? new InMemoryAppealFrameStore();
  const store = new InMemoryAppealStore();
  let n = 0;
  const service = createAppealService({
    store,
    faultStore,
    penaltyStore: new InMemoryPenaltyStore(),
    frameStore,
    hasConsent: async (_u, kind) => consents.includes(kind),
    publish: (e) => void events.push(e),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  return { service, store, frameStore, events };
}

async function open(service: ReturnType<typeof setup>["service"]) {
  const r = await service.open(
    USER,
    { subjectKind: "fault", subjectId: FAULT, reasonText: "I was at my desk" },
    later(1),
  );
  if (!r.ok) throw new Error("open failed");
  return r.appeal.id;
}

describe("appeal frame", () => {
  it("emits fault.appeal_decided and deletes the frame on decision", async () => {
    const { service, store, frameStore, events } = setup();
    const id = await open(service);
    expect(await service.attachFrame(USER, id, "ZnJhbWU=", later(2))).toMatchObject({ ok: true });
    expect(frameStore.has(USER, id)).toBe(true);
    expect(store.find(USER, id)?.hasEvidenceFrame).toBe(true);

    const r = await service.decide(USER, id, "overturned", later(3));
    expect(r.ok).toBe(true);
    expect(frameStore.has(USER, id)).toBe(false);
    expect(store.find(USER, id)?.hasEvidenceFrame).toBe(false);
    expect(events.filter((e) => e.type === "fault.appeal_decided")).toHaveLength(1);
    expect(store.audit(USER).map((a) => a.action)).toEqual([
      "appeal.opened",
      "appeal.frame_attached",
      "appeal.decided",
      "appeal.frame_deleted",
    ]);
  });

  it.each([
    ["no consent", [] as ConsentKind[], "rules.consent_missing"],
    ["only camera consent", ["camera"] as ConsentKind[], "rules.consent_missing"],
  ])("refuses a frame with %s and stores nothing", async (_n, consents, error) => {
    const { service, frameStore } = setup(consents);
    const id = await open(service);
    expect(await service.attachFrame(USER, id, "ZnJhbWU=", later(2))).toEqual({ ok: false, error });
    expect(frameStore.has(USER, id)).toBe(false);
  });

  it("refuses an empty frame, an unknown appeal, a second frame and a decided appeal", async () => {
    const { service } = setup();
    const id = await open(service);
    expect(await service.attachFrame(USER, id, "  ", later(2))).toMatchObject({
      error: "rules.invalid_appeal",
    });
    expect(
      await service.attachFrame(USER, "55555555-5555-4555-8555-555555555555", "x", later(2)),
    ).toMatchObject({ error: "rules.appeal_not_found" });
    await service.attachFrame(USER, id, "x", later(2));
    expect(await service.attachFrame(USER, id, "y", later(2))).toMatchObject({
      error: "rules.frame_already_attached",
    });
    await service.decide(USER, id, "upheld", later(3));
    expect(await service.attachFrame(USER, id, "z", later(4))).toMatchObject({
      error: "rules.appeal_already_decided",
    });
  });

  it("deletes the frame when upheld too, and retries a failed delete", async () => {
    const inner = new InMemoryAppealFrameStore();
    let fail = true;
    const flaky: AppealFrameStore = {
      put: (u, a, f) => inner.put(u, a, f),
      has: (u, a) => inner.has(u, a),
      delete: (u, a) => {
        if (fail) throw new Error("disk");
        return inner.delete(u, a);
      },
    };
    const { service, frameStore } = setup(["vision_frame"], flaky);
    const id = await open(service);
    await service.attachFrame(USER, id, "x", later(2));
    await service.decide(USER, id, "upheld", later(3));
    expect(frameStore.has(USER, id)).toBe(true);
    fail = false;
    await service.retryPending(USER, later(4));
    expect(frameStore.has(USER, id)).toBe(false);
  });

  it("never stores a frame when the service has no frame store", async () => {
    const base = setup();
    const id = await open(base.service);
    const service = createAppealService({
      store: base.store,
      faultStore: new InMemoryFaultStore(),
      penaltyStore: new InMemoryPenaltyStore(),
    });
    expect(await service.attachFrame(USER, id, "y", later(2))).toMatchObject({
      error: "rules.consent_missing",
    });
    expect(base.frameStore.has(USER, id)).toBe(false);
  });
});
