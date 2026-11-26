import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SignContractResponseSchema, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createContractService, InMemoryContractStore } from "../src/contract";

const NOW = new Date("2026-11-26T03:00:00.000Z");
const USER = "11111111-1111-4111-8111-111111111111";
const CYCLE = "22222222-2222-4222-8222-222222222222";

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function setup() {
  const events: EventEnvelope[] = [];
  const store = new InMemoryContractStore();
  const service = createContractService({
    store,
    publish: (e) => void events.push(e),
    now: () => NOW,
    newId: ids(),
  });
  return { events, store, service };
}

describe("sign commitment contract", () => {
  it("emits contract.signed once and stores the contract with its version", async () => {
    const { events, store, service } = setup();
    const result = await service.sign(USER, CYCLE);
    expect(result.alreadySigned).toBe(false);
    expect(result.contract).toMatchObject({
      cycleId: CYCLE,
      version: 1,
      signedAt: NOW.toISOString(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "contract.signed",
      userId: USER,
      payload: { contractId: result.contract.id, cycleId: CYCLE, version: 1 },
    });
    expect(store.findSigned(USER, CYCLE)).toEqual(result.contract);
  });

  it("emits no second event when signed again", async () => {
    const { events, service } = setup();
    const first = await service.sign(USER, CYCLE);
    const second = await service.sign(USER, CYCLE);
    expect(second.alreadySigned).toBe(true);
    expect(second.contract).toEqual(first.contract);
    expect(events).toHaveLength(1);
  });

  it("retries a failed publish without creating a second contract", async () => {
    const events: EventEnvelope[] = [];
    let fail = true;
    const service = createContractService({
      store: new InMemoryContractStore(),
      publish: (e) => {
        if (fail) throw new Error("nats down");
        events.push(e);
      },
      now: () => NOW,
      newId: ids(),
    });
    const first = await service.sign(USER, CYCLE);
    fail = false;
    const second = await service.sign(USER, CYCLE);
    await service.sign(USER, CYCLE);
    expect(second.contract.id).toBe(first.contract.id);
    expect(events).toHaveLength(1);
  });

  it("serves POST /contracts/sign", async () => {
    const events: EventEnvelope[] = [];
    const app = await createApp(
      loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" }),
      { publish: (e) => void events.push(e) },
    );
    const call = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/contracts/sign", headers, payload: { cycleId: CYCLE } });
    const res = await call({ "x-user-id": USER });
    expect(res.statusCode).toBe(200);
    expect(SignContractResponseSchema.safeParse(res.json()).success).toBe(true);
    await call({ "x-user-id": USER });
    expect(events).toHaveLength(1);
    expect((await call({})).statusCode).toBe(401);
  });
});
