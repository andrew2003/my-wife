import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const CAT = "22222222-2222-4222-8222-222222222222";

async function draft() {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date("2026-11-23T08:00:00Z"),
    publish: (e: EventEnvelope) => void events.push(e),
  });
  const created = await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  return { app, events, id: created.json().data.week.id as string };
}

describe("planned items on approval (#310)", () => {
  it("copies approved planned items into week.planned", async () => {
    const { app, events, id } = await draft();
    const res = await app.inject({
      method: "POST",
      url: `/weeks/${id}/approve`,
      headers: H,
      payload: { plannedItems: [{ categoryId: CAT, amountVnd: 120_000 }] },
    });
    expect(res.statusCode).toBe(200);
    const event = events.find((e) => e.type === "week.planned")!;
    expect(parseEvent(event).success).toBe(true);
    expect(event.payload).toMatchObject({
      weekId: id,
      plannedItems: [{ categoryId: CAT, amountVnd: 120_000 }],
    });
  });

  it("rejects fractional or negative amounts and leaves the week a draft", async () => {
    const { app, events, id } = await draft();
    for (const amountVnd of [10.5, -1]) {
      const res = await app.inject({
        method: "POST",
        url: `/weeks/${id}/approve`,
        headers: H,
        payload: { plannedItems: [{ categoryId: CAT, amountVnd }] },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(events.filter((e) => e.type === "week.planned")).toHaveLength(0);
    const ok = await app.inject({ method: "POST", url: `/weeks/${id}/approve`, headers: H });
    expect(ok.statusCode).toBe(200);
  });

  it("omits plannedItems when none are given", async () => {
    const { app, events, id } = await draft();
    await app.inject({ method: "POST", url: `/weeks/${id}/approve`, headers: H });
    expect(events.find((e) => e.type === "week.planned")!.payload).not.toHaveProperty(
      "plannedItems",
    );
  });
});
