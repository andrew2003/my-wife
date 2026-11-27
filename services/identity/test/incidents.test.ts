import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";

const ADMIN = { "x-user-id": "admin1", "x-user-role": "admin" };
const USER = { "x-user-id": "u1", "x-user-role": "user" };
const OTHER = { "x-user-id": "u2", "x-user-role": "user" };
const AT = (hm: string) => `2026-11-26T${hm}:00.000Z`;

function setup() {
  const events: EventEnvelope[] = [];
  let clock = new Date(AT("16:00"));
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32) });
  const app = createApp(config, {
    store: createMemoryStore(),
    now: () => clock,
    publish: (e) => void events.push(e),
  });
  const declare = (payload: Record<string, unknown>, headers: Record<string, string> = ADMIN) =>
    app.inject({ method: "POST", url: "/admin/incidents", headers, payload });
  return { app, events, declare, tick: (d: Date) => (clock = d) };
}
const window = { startsAt: AT("14:00"), endsAt: AT("14:30"), scope: "all", reason: "Bank outage" };

describe("incident declaration", () => {
  it("declares a closed past incident as ended and announces it so faults are waived", async () => {
    const { declare, events } = setup();
    const res = await declare(window);
    expect(res.statusCode).toBe(201);
    const inc = res.json().data.incident;
    expect(inc).toMatchObject({ state: "ended", startsAt: AT("14:00"), endsAt: AT("14:30") });
    const declared = events.filter((e) => e.type === "incident.declared");
    expect(declared).toHaveLength(1);
    expect(declared[0]?.payload).toEqual({
      incidentId: inc.id,
      startsAt: AT("14:00"),
      endsAt: AT("14:30"),
      scope: "all",
    });
  });

  it("declares an open-ended incident as active", async () => {
    const { declare } = setup();
    const res = await declare({ ...window, endsAt: null });
    expect(res.json().data.incident.state).toBe("active");
  });

  it("shows the reason to an affected user for the weekly report", async () => {
    const { declare, app } = setup();
    const id = (await declare(window)).json().data.incident.id;
    const res = await app.inject({ method: "GET", url: `/incidents/${id}`, headers: USER });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.incident).toMatchObject({ id, reason: "Bank outage" });
  });

  it("hides a scoped incident from users outside the scope", async () => {
    const { declare, app } = setup();
    const id = (await declare({ ...window, scope: ["u1"] })).json().data.incident.id;
    expect(
      (await app.inject({ method: "GET", url: `/incidents/${id}`, headers: OTHER })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/incidents/${id}`, headers: USER })).statusCode,
    ).toBe(200);
  });

  it("requires an admin, a reason and a valid window", async () => {
    const { declare, events } = setup();
    expect((await declare(window, USER)).statusCode).toBe(403);
    expect((await declare({ ...window, reason: "  " })).statusCode).toBe(400);
    expect((await declare({ ...window, endsAt: AT("13:00") })).statusCode).toBe(400);
    expect((await declare({ ...window, scope: [] })).statusCode).toBe(400);
    expect(events).toHaveLength(0);
  });

  it("writes an audit entry without personal content", async () => {
    const { declare, app } = setup();
    const id = (await declare(window)).json().data.incident.id;
    const res = await app.inject({ method: "GET", url: "/admin/audit", headers: ADMIN });
    expect(res.json().data.entries).toEqual([
      expect.objectContaining({
        actorId: "admin1",
        action: "incident.declared",
        targetId: id,
        before: null,
        after: expect.objectContaining({ state: "ended", reason: "Bank outage" }),
        at: AT("16:00"),
      }),
    ]);
  });
});

describe("incident end and cancel", () => {
  it("ends an active incident", async () => {
    const { declare, app, events, tick } = setup();
    const id = (await declare({ ...window, endsAt: null })).json().data.incident.id;
    tick(new Date(AT("17:00")));
    const res = await app.inject({
      method: "POST",
      url: `/admin/incidents/${id}/end`,
      headers: ADMIN,
      payload: {},
    });
    expect(res.json().data.incident).toMatchObject({ state: "ended", endsAt: AT("17:00") });
    expect(events.at(-1)).toMatchObject({
      type: "incident.ended",
      payload: { incidentId: id, endsAt: AT("17:00") },
    });
  });

  it("rejects ending before the start or twice", async () => {
    const { declare, app } = setup();
    const id = (await declare({ ...window, endsAt: null })).json().data.incident.id;
    const end = (endsAt: string) =>
      app.inject({
        method: "POST",
        url: `/admin/incidents/${id}/end`,
        headers: ADMIN,
        payload: { endsAt },
      });
    expect((await end(AT("13:00"))).statusCode).toBe(400);
    expect((await end(AT("15:00"))).statusCode).toBe(200);
    expect((await end(AT("15:30"))).statusCode).toBe(409);
  });

  it.each([[123], [true], [""], ["not a date"], ["2026-11-26"], [null]])(
    "rejects a non-ISO end %j with a 400 and keeps the incident active",
    async (endsAt) => {
      const { declare, app, events } = setup();
      const id = (await declare({ ...window, endsAt: null })).json().data.incident.id;
      const before = events.length;
      const res = await app.inject({
        method: "POST",
        url: `/admin/incidents/${id}/end`,
        headers: ADMIN,
        payload: { endsAt },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("identity.incident_invalid");
      expect(events).toHaveLength(before);
      const list = await app.inject({ method: "GET", url: "/admin/incidents", headers: ADMIN });
      expect(list.json().data.incidents[0].state).toBe("active");
    },
  );

  it("accepts an open-ended incident that starts in the future and rejects ending before it starts", async () => {
    const { declare, app } = setup();
    const res = await declare({ ...window, startsAt: AT("20:00"), endsAt: null });
    expect(res.statusCode).toBe(201);
    const id = res.json().data.incident.id;
    expect(res.json().data.incident.state).toBe("active");
    const end = (endsAt: string) =>
      app.inject({
        method: "POST",
        url: `/admin/incidents/${id}/end`,
        headers: ADMIN,
        payload: { endsAt },
      });
    expect((await end(AT("19:00"))).statusCode).toBe(400);
    expect((await end(AT("21:00"))).statusCode).toBe(200);
  });

  it("cancels a mistaken incident so rules re-evaluate its waivers", async () => {
    const { declare, app, events } = setup();
    const id = (await declare(window)).json().data.incident.id;
    const res = await app.inject({
      method: "POST",
      url: `/admin/incidents/${id}/cancel`,
      headers: ADMIN,
    });
    expect(res.json().data.incident.state).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({
      type: "incident.cancelled",
      payload: { incidentId: id },
    });
    const again = await app.inject({
      method: "POST",
      url: `/admin/incidents/${id}/cancel`,
      headers: ADMIN,
    });
    expect(again.statusCode).toBe(409);
    expect(
      (await app.inject({ method: "GET", url: `/incidents/${id}`, headers: USER })).json().data
        .incident.state,
    ).toBe("cancelled");
  });

  it("answers 404 for unknown incidents and 403 for non-admins", async () => {
    const { app } = setup();
    const url = "/admin/incidents/nope/cancel";
    expect((await app.inject({ method: "POST", url, headers: ADMIN })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers: USER })).statusCode).toBe(403);
  });
});
