import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createMemorySessionStore, type WorkSession } from "../src/sessions";
import en from "../src/locales/en.json";
import vi from "../src/locales/vi.json";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

// Defaults: UTC+7, lunch window 11:30-13:30 local = 04:30Z-06:30Z on 2026-11-24.
const session = (startedAt: string, minutes: number, endedAt: string | null): WorkSession => ({
  id: `s-${startedAt}`,
  userId: "u1",
  taskId: "t1",
  startedAt,
  durationMinutes: minutes,
  endedAt,
  endAnnounced: true,
  pomodoroBreak: { kind: "break", minutes: 5 },
});

async function setup(
  sessions: WorkSession[],
  settings: Record<string, unknown> = {},
  menu?: (userId: string, date: string, mealId: string) => Promise<string | undefined>,
) {
  const events: EventEnvelope[] = [];
  const sessionStore = createMemorySessionStore();
  sessions.forEach((s) => sessionStore.add(s));
  const app = await createApp(config, {
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
    now: () => new Date("2026-11-24T07:00:00.000Z"),
    sessionStore,
    ...(menu ? { menuSource: menu } : {}),
  });
  await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  events.length = 0;
  return { app, events };
}

const breaks = (events: EventEnvelope[]) =>
  events.filter((e) => String(e.id).startsWith("routine-meal-break-"));

describe("meal break prompt", () => {
  it("prompts a break naming today's dish when the window passes while working", async () => {
    const { app, events } = await setup(
      [session("2026-11-24T04:00:00.000Z", 180, null)],
      {},
      async (_u, date, meal) =>
        date === "2026-11-24" && meal === "lunch" ? "Canh chua" : undefined,
    );
    await app.runRoutineJob(new Date("2026-11-24T06:29:00.000Z"));
    expect(breaks(events)).toHaveLength(0);
    await app.runRoutineJob(new Date("2026-11-24T06:30:00.000Z"));
    const b = breaks(events);
    expect(b).toHaveLength(1);
    expect(b[0]!.type).toBe("routine.reminder_due");
    expect(b[0]!.payload).toMatchObject({
      routine: "meal",
      messageKey: "routine.meal_break.lunch_menu",
      params: { dish: "Canh chua", minutes: 30 },
    });
  });

  it("prompts without a dish when no menu exists, and only once", async () => {
    const { app, events } = await setup([session("2026-11-24T04:00:00.000Z", 180, null)]);
    await app.runRoutineJob(new Date("2026-11-24T06:30:00.000Z"));
    await app.runRoutineJob(new Date("2026-11-24T06:45:00.000Z"));
    const b = breaks(events);
    expect(b).toHaveLength(1);
    expect(b[0]!.payload).toMatchObject({ messageKey: "routine.meal_break.lunch" });
  });

  it("falls back to the plain prompt when the menu lookup fails", async () => {
    const { app, events } = await setup(
      [session("2026-11-24T04:00:00.000Z", 180, null)],
      {},
      async () => {
        throw new Error("down");
      },
    );
    await app.runRoutineJob(new Date("2026-11-24T06:30:00.000Z"));
    expect(breaks(events)[0]!.payload).toMatchObject({ messageKey: "routine.meal_break.lunch" });
  });

  it("prompts only when a session overlapped the window", async () => {
    const worked = await setup([
      session("2026-11-24T02:00:00.000Z", 60, "2026-11-24T03:00:00.000Z"),
      session("2026-11-24T06:00:00.000Z", 20, "2026-11-24T06:20:00.000Z"),
    ]);
    await worked.app.runRoutineJob(new Date("2026-11-24T06:30:00.000Z"));
    expect(breaks(worked.events)).toHaveLength(1);
    const none = await setup([session("2026-11-24T02:00:00.000Z", 60, "2026-11-24T03:00:00.000Z")]);
    await none.app.runRoutineJob(new Date("2026-11-24T06:30:00.000Z"));
    expect(breaks(none.events)).toHaveLength(0);
  });

  it("does not prompt when the meal routine is off", async () => {
    const { app, events } = await setup([session("2026-11-24T04:00:00.000Z", 180, null)], {
      "routine.lunch.level": "off",
    });
    await app.runRoutineJob(new Date("2026-11-24T06:30:00.000Z"));
    expect(breaks(events)).toHaveLength(0);
  });

  it("uses the window setting, not a fixed time", async () => {
    const { app, events } = await setup([session("2026-11-24T04:00:00.000Z", 300, null)], {
      "routine.meal.lunch_window": { from: "11:30", to: "14:30", durationMinutes: 30 },
    });
    await app.runRoutineJob(new Date("2026-11-24T06:30:00.000Z"));
    expect(breaks(events)).toHaveLength(0);
    await app.runRoutineJob(new Date("2026-11-24T07:30:00.000Z"));
    expect(breaks(events)).toHaveLength(1);
  });

  it("has vi and en texts for every meal break key", () => {
    for (const id of ["breakfast", "lunch", "dinner"]) {
      for (const key of [`routine.meal_break.${id}`, `routine.meal_break.${id}_menu`]) {
        expect((en as Record<string, string>)[key]).toBeTruthy();
        expect((vi as Record<string, string>)[key]).toBeTruthy();
      }
    }
  });
});
