import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const DEFAULT_WEEKS = SETTINGS["monitor.taper_clean_weeks"].default;
const DAY_MS = 86_400_000;
const FIRST_MONDAY = Date.parse("2026-11-02T00:00:00.000Z");

const weekClosed = (index: number, userId = "u1"): EventEnvelope =>
  ({
    id: `evt-w${index}`,
    type: "week.closed",
    occurredAt: new Date(FIRST_MONDAY + (index + 1) * 7 * DAY_MS).toISOString(),
    userId,
    schemaVersion: 1,
    payload: {
      weekId: `w${index}`,
      firstDay: new Date(FIRST_MONDAY + index * 7 * DAY_MS).toISOString().slice(0, 10),
      weekIndexInCycle: null,
    },
  }) as EventEnvelope;

const reply = (
  questionId: string,
  value: string,
  userId = "u1",
  override: Record<string, unknown> = {},
): EventEnvelope =>
  ({
    id: `evt-r-${questionId}-${value}`,
    type: "notify.reply_received",
    occurredAt: new Date(FIRST_MONDAY + 60 * DAY_MS).toISOString(),
    userId,
    schemaVersion: 1,
    payload: {
      questionId,
      sourceService: "monitor",
      kind: "supervision_taper",
      value,
      answeredAt: new Date(FIRST_MONDAY + 60 * DAY_MS).toISOString(),
      via: "chat",
      ...override,
    },
  }) as EventEnvelope;

const expired = (questionId: string, override: Record<string, unknown> = {}): EventEnvelope =>
  ({
    id: `evt-x-${questionId}`,
    type: "notify.question_expired",
    occurredAt: new Date(FIRST_MONDAY + 60 * DAY_MS).toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { questionId, sourceService: "monitor", kind: "supervision_taper", ...override },
  }) as EventEnvelope;

const specialStarted = (periodId: string, from: Date, to: Date): EventEnvelope =>
  ({
    id: `evt-s-${periodId}`,
    type: "special_mode.started",
    occurredAt: from.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      periodId,
      kind: "sick",
      from: from.toISOString(),
      to: to.toISOString(),
      retroactive: false,
    },
  }) as EventEnvelope;

async function setup(settings: Record<string, unknown> = {}) {
  const nowMs = FIRST_MONDAY + 60 * DAY_MS;
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date(nowMs),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
  });
  const ofType = (t: string) => events.filter((e) => e.type === t);
  const levels = () =>
    ofType("supervision.level_changed").map((e) => (e.payload as { to: string }).to);
  return { app, events, ofType, levels };
}

const questionOf = (e: EventEnvelope | undefined) =>
  (e?.payload as { questionId: string }).questionId;

describe("tapering supervision levels", () => {
  it("asks ask.supervision_taper after the configured clean streak and applies it on confirmation", async () => {
    const s = await setup();
    for (let i = 0; i < DEFAULT_WEEKS - 1; i++) await s.app.onWeekClosed(weekClosed(i));
    expect(s.ofType("ask.supervision_taper")).toEqual([]);
    await s.app.onWeekClosed(weekClosed(DEFAULT_WEEKS - 1));
    const asks = s.ofType("ask.supervision_taper");
    expect(asks).toHaveLength(1);
    const ask = asks[0]!.payload as {
      kind: string;
      options: { value: string }[];
      params: Record<string, unknown>;
    };
    expect(ask.kind).toBe("supervision_taper");
    expect(ask.options.map((o) => o.value)).toEqual(["accept", "decline"]);
    expect(ask.params).toMatchObject({ from: "full", to: "no_camera", weeks: DEFAULT_WEEKS });
    expect(s.ofType("supervision.level_changed")).toEqual([]);
    expect(s.app.supervisionOf("u1").level).toBe("full");

    await s.app.onReplyReceived(reply(questionOf(asks[0]), "accept"));
    const changed = s.ofType("supervision.level_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      from: "full",
      to: "no_camera",
      cause: "taper_accepted",
    });
    expect(s.app.supervisionOf("u1").level).toBe("no_camera");
    // A second tap changes nothing.
    await s.app.onReplyReceived(reply(questionOf(asks[0]), "accept"));
    expect(s.ofType("supervision.level_changed")).toHaveLength(1);
  });

  it("uses the user's streak length setting", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 2 });
    await s.app.onWeekClosed(weekClosed(0));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(0);
    await s.app.onWeekClosed(weekClosed(1));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1);
  });

  it("takes effect from the next week (loosening lock)", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 1 });
    await s.app.onWeekClosed(weekClosed(0));
    await s.app.onReplyReceived(reply(questionOf(s.ofType("ask.supervision_taper")[0]), "accept"));
    const p = s.ofType("supervision.level_changed")[0]!.payload as { effectiveFrom: string };
    expect(Date.parse(p.effectiveFrom)).toBeGreaterThanOrEqual(FIRST_MONDAY + 7 * DAY_MS);
  });

  it("snoozes a declined ask for the configured number of clean weeks", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 2 });
    await s.app.onWeekClosed(weekClosed(0));
    await s.app.onWeekClosed(weekClosed(1));
    await s.app.onReplyReceived(reply(questionOf(s.ofType("ask.supervision_taper")[0]), "decline"));
    expect(s.ofType("supervision.level_changed")).toEqual([]);
    expect(s.app.supervisionOf("u1").level).toBe("full");
    await s.app.onWeekClosed(weekClosed(2));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1);
    await s.app.onWeekClosed(weekClosed(3));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(2);
  });

  it("treats an expired question like a refusal and snoozes", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 2 });
    await s.app.onWeekClosed(weekClosed(0));
    await s.app.onWeekClosed(weekClosed(1));
    const q = questionOf(s.ofType("ask.supervision_taper")[0]);
    await s.app.onReplyReceived(expired(q));
    await s.app.onWeekClosed(weekClosed(2));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1);
    await s.app.onWeekClosed(weekClosed(3));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(2);
    expect(s.ofType("supervision.level_changed")).toEqual([]);
  });

  it("ignores replies and expiries with a foreign source service or kind", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 1 });
    await s.app.onWeekClosed(weekClosed(0));
    const q = questionOf(s.ofType("ask.supervision_taper")[0]);
    await s.app.onReplyReceived(reply(q, "accept", "u1", { sourceService: "budget" }));
    await s.app.onReplyReceived(reply(q, "accept", "u1", { kind: "carry_over" }));
    await s.app.onReplyReceived(expired(q, { sourceService: "budget" }));
    expect(s.ofType("supervision.level_changed")).toEqual([]);
    await s.app.onWeekClosed(weekClosed(1));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1); // still pending
    await s.app.onReplyReceived(reply(q, "accept"));
    expect(s.levels()).toEqual(["no_camera"]);
  });

  it.each([
    {
      name: "a special-mode week is neutral between clean weeks",
      special: [1],
      fault: null,
      asks: [0, 0, 1],
    },
    { name: "a fault week resets the streak", special: [], fault: 1, asks: [0, 0, 0] },
    {
      name: "a fault in a special-mode week stays neutral",
      special: [1],
      fault: 1,
      asks: [0, 0, 1],
    },
  ])("$name", async ({ special, fault, asks }) => {
    const s = await setup({ "monitor.taper_clean_weeks": 2 });
    for (const w of special) {
      const from = new Date(FIRST_MONDAY + (w * 7 + 2) * DAY_MS);
      await s.app.onSpecialMode(specialStarted(`p${w}`, from, new Date(from.getTime() + DAY_MS)));
    }
    if (fault !== null) {
      const at = new Date(FIRST_MONDAY + fault * 7 * DAY_MS + 3600_000).toISOString();
      s.app.monitorState.tickets.add({
        id: "t1",
        userId: "u1",
        sessionId: "s1",
        signal: "heartbeat_lost",
        signalRef: "ref-1",
        state: "expired",
        occurredAt: at,
        createdAt: at,
      });
    }
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await s.app.onWeekClosed(weekClosed(i));
      counts.push(s.ofType("ask.supervision_taper").length);
    }
    expect(counts).toEqual(asks);
  });

  it("does not ask twice while a question is open and ignores redelivery", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 1 });
    await s.app.onWeekClosed(weekClosed(0));
    await s.app.onWeekClosed(weekClosed(0));
    await s.app.onWeekClosed(weekClosed(1));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1);
  });

  it("resets the streak after a week with a fault", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 2 });
    await s.app.onWeekClosed(weekClosed(0));
    const at = new Date(FIRST_MONDAY + 7 * DAY_MS + 3600_000).toISOString();
    s.app.monitorState.tickets.add({
      id: "t1",
      userId: "u1",
      sessionId: "s1",
      signal: "heartbeat_lost",
      signalRef: "ref-1",
      state: "expired",
      occurredAt: at,
      createdAt: at,
    });
    await s.app.onWeekClosed(weekClosed(1));
    await s.app.onWeekClosed(weekClosed(2));
    expect(s.ofType("ask.supervision_taper")).toEqual([]);
    await s.app.onWeekClosed(weekClosed(3));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1);
  });

  it("does not count a fault waived by an outage against the streak", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 1 });
    const at = new Date(FIRST_MONDAY + 3600_000).toISOString();
    s.app.monitorState.tickets.add({
      id: "t1",
      userId: "u1",
      sessionId: "s1",
      signal: "heartbeat_lost",
      signalRef: "ref-1",
      state: "expired",
      occurredAt: at,
      createdAt: at,
    });
    s.app.monitorState.waivers.add({
      signalRef: "ref-1",
      userId: "u1",
      sessionId: "s1",
      outageId: "o1",
      source: "platform",
      gapStartedAt: at,
      gapEndedAt: at,
      marginSeconds: 60,
      recordedAt: at,
    } as never);
    await s.app.onWeekClosed(weekClosed(0));
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1);
  });

  it("walks down one level at a time and stops at graduated", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 1 });
    for (let i = 0; i < 5; i++) {
      const before = s.ofType("ask.supervision_taper").length;
      await s.app.onWeekClosed(weekClosed(i));
      const asks = s.ofType("ask.supervision_taper");
      if (asks.length === before) break;
      await s.app.onReplyReceived(reply(questionOf(asks.at(-1)), "accept"));
    }
    expect(s.levels()).toEqual(["no_camera", "checklist_only", "graduated"]);
    expect(s.app.supervisionOf("u1").level).toBe("graduated");
  });

  it("starts from the user's configured level and asks nothing for graduated users", async () => {
    const s = await setup({
      "monitor.supervision_level": "graduated",
      "monitor.taper_clean_weeks": 1,
    });
    await s.app.onWeekClosed(weekClosed(0));
    expect(s.ofType("ask.supervision_taper")).toEqual([]);
  });

  it("ignores replies for unknown questions", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 1 });
    await s.app.onWeekClosed(weekClosed(0));
    await s.app.onReplyReceived(reply("unknown", "accept"));
    expect(s.ofType("supervision.level_changed")).toEqual([]);
  });

  it("accepts the week.closed envelope over the internal REST entry", async () => {
    const s = await setup({ "monitor.taper_clean_weeks": 1 });
    const res = await s.app.inject({
      method: "POST",
      url: "/events/week-closed",
      payload: weekClosed(0),
    });
    expect(res.statusCode).toBe(200);
    expect(s.ofType("ask.supervision_taper")).toHaveLength(1);
  });
});
