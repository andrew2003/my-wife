import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp, createConsentStore, effectiveSupervisionLevel } from "../src/index";

const A = { "x-user-id": "ua" };
const B = { "x-user-id": "ub" };

function setup(textVersions?: Record<string, number>) {
  let clock = new Date("2026-01-01T00:00:00Z");
  const events: EventEnvelope[] = [];
  const consentStore = createConsentStore();
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32) });
  const app = createApp(config, {
    consentStore,
    consentTextVersions: textVersions,
    now: () => clock,
    publish: (e) => void events.push(e),
  });
  return { app, events, consentStore, tick: (d: Date) => (clock = d) };
}
type App = ReturnType<typeof setup>["app"];
const grant = (app: App, kind: string, textVersion = 1, headers = A) =>
  app.inject({ method: "POST", url: "/consents", headers, payload: { kind, textVersion } });
const revoke = (app: App, kind: string, headers = A) =>
  app.inject({ method: "DELETE", url: `/consents/${kind}`, headers });
const check = (app: App, kind: string, headers = A) =>
  app.inject({ method: "GET", url: `/consents/${kind}/check`, headers });

describe("consents", () => {
  it("rejects unauthenticated and invalid requests", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/consents" })).statusCode).toBe(401);
    expect((await grant(app, "nope")).statusCode).toBe(400);
    expect((await revoke(app, "nope")).statusCode).toBe(400);
  });

  it("is not granted until the user grants it", async () => {
    const { app } = setup();
    const res = await check(app, "email");
    expect(res.json().data).toMatchObject({ kind: "email", granted: false });
  });

  it("grants, lists and emits consent.granted", async () => {
    const { app, events } = setup();
    expect((await grant(app, "email")).statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: "/consents", headers: A })).json();
    expect(list.data.consents).toEqual([
      { kind: "email", textVersion: 1, grantedAt: "2026-01-01T00:00:00.000Z", revokedAt: null },
    ]);
    expect((await check(app, "email")).json().data.granted).toBe(true);
    expect(events.map((e) => [e.type, e.userId])).toEqual([["consent.granted", "ua"]]);
    expect(events[0]?.payload).toEqual({ kind: "email", textVersion: 1 });
  });

  it("revoking email makes mail arrival rejected (check says not granted)", async () => {
    const { app, events, tick } = setup();
    await grant(app, "email");
    tick(new Date("2026-01-02T00:00:00Z"));
    expect((await revoke(app, "email")).statusCode).toBe(200);
    const res = await check(app, "email");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ granted: false, reason: "revoked" });
    expect(events.at(-1)?.type).toBe("consent.revoked");
    const list = (await app.inject({ method: "GET", url: "/consents", headers: A })).json();
    expect(list.data.consents[0].revokedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("revoking something never granted is a no-op without an event", async () => {
    const { app, events } = setup();
    expect((await revoke(app, "bank")).statusCode).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("keeps an audit trail of grants and revocations", async () => {
    const { app, consentStore } = setup();
    await grant(app, "camera");
    await revoke(app, "camera");
    await grant(app, "camera");
    const audit = await consentStore.listAudit("ua");
    expect(audit.map((a) => a.action)).toEqual(["granted", "revoked", "granted"]);
    const res = await app.inject({ method: "GET", url: "/consents/audit", headers: A });
    expect(res.json().data.audit).toHaveLength(3);
  });

  it("a consent text change requires consent again", async () => {
    const { app } = setup({ camera: 2 });
    expect((await grant(app, "camera", 1)).statusCode).toBe(409);
    expect((await grant(app, "camera", 2)).statusCode).toBe(200);
  });

  it("a stale text version is not granted after the text changes", async () => {
    const store = createConsentStore();
    const config = loadConfig({ SESSION_SECRET: "s".repeat(32) });
    const v1 = createApp(config, { consentStore: store });
    await grant(v1, "camera", 1);
    const v2 = createApp(config, { consentStore: store, consentTextVersions: { camera: 2 } });
    expect((await check(v2, "camera")).json().data).toMatchObject({
      granted: false,
      reason: "text_outdated",
      requiredTextVersion: 2,
    });
  });

  it("isolates users", async () => {
    const { app } = setup();
    await grant(app, "email");
    expect((await check(app, "email", B)).json().data.granted).toBe(false);
  });

  it("revoked camera makes monitoring unavailable and drops the level to no_camera", async () => {
    const { app } = setup();
    const ask = (requested: string) =>
      app.inject({
        method: "POST",
        url: "/consents/supervision-level",
        headers: A,
        payload: { requested },
      });
    expect((await ask("full")).json().data).toMatchObject({
      level: "no_camera",
      cameraAvailable: false,
    });
    await grant(app, "camera");
    expect((await ask("full")).json().data).toMatchObject({ level: "full", cameraAvailable: true });
    await revoke(app, "camera");
    expect((await ask("full")).json().data).toMatchObject({
      level: "no_camera",
      cameraAvailable: false,
    });
    expect((await ask("checklist_only")).json().data.level).toBe("checklist_only");
    expect((await ask("bogus")).statusCode).toBe(400);
  });
});

describe("effectiveSupervisionLevel", () => {
  it.each([
    ["full", true, "full"],
    ["full", false, "no_camera"],
    ["graduated", false, "no_camera"],
    ["graduated", true, "graduated"],
    ["no_camera", false, "no_camera"],
    ["checklist_only", false, "checklist_only"],
  ] as const)("%s with camera=%s gives %s", (requested, camera, expected) => {
    expect(effectiveSupervisionLevel(requested, camera)).toBe(expected);
  });
});
