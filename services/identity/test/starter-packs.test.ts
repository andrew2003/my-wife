import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, validateSettingValue, type EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";
import { STARTER_PACKS } from "../src/starter-packs";

const USER = { "x-user-id": "u1" };

function setup() {
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" });
  const events: EventEnvelope[] = [];
  const app = createApp(config, {
    store: createMemoryStore(),
    now: () => new Date("2026-01-01T00:00:00Z"),
    publish: (e) => {
      events.push(e);
    },
  });
  return { app, events };
}
const values = async (app: ReturnType<typeof setup>["app"]) =>
  (await app.inject({ method: "GET", url: "/settings", headers: USER })).json().data.values;

describe("starter packs", () => {
  it("lists the three packs with locale keys, not text", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/onboarding/packs", headers: USER });
    const packs = res.json().data.packs as { id: string; nameKey: string }[];
    expect(packs.map((p) => p.id)).toEqual(["student", "regular_worker", "freelancer"]);
    expect(packs.every((p) => p.nameKey.startsWith("onboarding.pack."))).toBe(true);
  });

  it("every pack value is a valid setting", () => {
    for (const pack of STARTER_PACKS)
      for (const [key, value] of Object.entries(pack.settings))
        expect(validateSettingValue(key as never, value).success, `${pack.id} ${key}`).toBe(true);
  });

  it("every pack keeps sleep and meals at track and wake-up at remind", () => {
    for (const pack of STARTER_PACKS) {
      const s = pack.settings as Record<string, unknown>;
      expect(s["routine.sleep.level"] ?? "track").toBe("track");
      expect(s["routine.meals.level"] ?? "track").toBe("track");
      expect(s["routine.wake.level"] ?? "remind").toBe("remind");
    }
  });

  it("the student pack sets schedule and budget values", async () => {
    const { app, events } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/onboarding/packs/student/apply",
      headers: USER,
    });
    expect(res.statusCode).toBe(200);
    const student = STARTER_PACKS.find((p) => p.id === "student")!;
    const v = await values(app);
    const keys = Object.keys(student.settings);
    expect(keys.some((k) => /^(schedule|routine)\./.test(k))).toBe(true);
    expect(keys.some((k) => k.startsWith("budget."))).toBe(true);
    for (const [k, val] of Object.entries(student.settings)) expect(v[k]).toEqual(val);
    expect(events.filter((e) => e.type === "user.updated")).toHaveLength(1);
  });

  it("keeps the registry default for keys a pack does not set", async () => {
    const { app } = setup();
    await app.inject({ method: "POST", url: "/onboarding/packs/freelancer/apply", headers: USER });
    expect((await values(app))["penalty.weekly_cap_vnd"]).toBe(
      SETTINGS["penalty.weekly_cap_vnd"].default,
    );
  });

  it("refuses an unknown pack and a missing user", async () => {
    const { app } = setup();
    const bad = await app.inject({
      method: "POST",
      url: "/onboarding/packs/nope/apply",
      headers: USER,
    });
    expect(bad.statusCode).toBe(404);
    const anon = await app.inject({ method: "POST", url: "/onboarding/packs/student/apply" });
    expect(anon.statusCode).toBe(401);
  });

  it("applying twice emits once", async () => {
    const { app, events } = setup();
    const url = "/onboarding/packs/student/apply";
    await app.inject({ method: "POST", url, headers: USER });
    await app.inject({ method: "POST", url, headers: USER });
    expect(events.filter((e) => e.type === "user.updated")).toHaveLength(1);
  });
});
