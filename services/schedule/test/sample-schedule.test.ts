import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { buildSampleDay } from "../src/sample-schedule";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const NOW = new Date("2026-11-26T08:00:00Z");

describe("buildSampleDay", () => {
  it("returns the standard day template, every time editable, when there are no answers", () => {
    const blocks = buildSampleDay({});
    expect(blocks.map((b) => [b.titleKey, b.start, b.end])).toEqual([
      ["schedule.sample.wake", "06:00", "06:00"],
      ["schedule.sample.hygiene", "06:00", "07:30"],
      ["schedule.sample.top_three", "07:30", "07:45"],
      ["schedule.sample.deep_work", "08:00", "12:00"],
      ["schedule.sample.lunch", "12:00", "13:30"],
      ["schedule.sample.work", "13:30", "17:30"],
      ["schedule.sample.exercise_dinner", "17:30", "19:30"],
      ["schedule.sample.study", "19:30", "21:30"],
      ["schedule.sample.reflection", "21:30", "22:00"],
      ["schedule.sample.sleep", "23:00", "23:00"],
    ]);
    expect(blocks.every((b) => b.editable)).toBe(true);
  });

  it("makes the routine blocks follow the answers", () => {
    const blocks = buildSampleDay({ "routine.wake.time": "07:00", "routine.sleep.start": "22:30" });
    const by = (k: string) => blocks.find((b) => b.titleKey === `schedule.sample.${k}`)!;
    expect(by("wake").start).toBe("07:00");
    expect(by("hygiene")).toMatchObject({ start: "07:00", end: "08:30" });
    expect(by("top_three").start).toBe("08:30");
    expect(by("deep_work")).toMatchObject({ start: "09:00", end: "12:00" });
    expect(by("sleep").start).toBe("22:30");
  });
});

describe("onboarding.step_completed consumer", () => {
  const event = (step: string, skipped: boolean) => ({
    id: "e1",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step, skipped },
  });

  for (const skipped of [true, false]) {
    it(`generates the sample schedule once (skipped ${skipped})`, async () => {
      const app = await createApp(config, {
        now: () => NOW,
        readSettings: async () => (skipped ? {} : { "routine.wake.time": "07:00" }),
      });
      const post = () =>
        app.inject({
          method: "POST",
          url: "/events/onboarding-step-completed",
          payload: event("qa_templates", skipped),
        });
      expect((await post()).json().data.generated).toBe(true);
      expect((await post()).json().data.generated).toBe(false);
      const res = await app.inject({
        method: "GET",
        url: "/sample-schedule",
        headers: { "x-user-id": "u1" },
      });
      const data = res.json().data;
      expect(data.generatedAt).toBe(NOW.toISOString());
      expect(data.blocks[0].start).toBe(skipped ? "06:00" : "07:00");
    });
  }

  it("ignores other steps", async () => {
    const app = await createApp(config, { now: () => NOW, readSettings: async () => ({}) });
    const res = await app.inject({
      method: "POST",
      url: "/events/onboarding-step-completed",
      payload: event("tour", false),
    });
    expect(res.json().data.generated).toBe(false);
    const get = await app.inject({
      method: "GET",
      url: "/sample-schedule",
      headers: { "x-user-id": "u1" },
    });
    expect(get.statusCode).toBe(404);
  });
});
