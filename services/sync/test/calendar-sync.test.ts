import { describe, expect, it } from "vitest";
import {
  CalendarSyncService,
  CalendarEventExistsError,
  InMemoryEventMap,
  type CalendarClient,
  type CalendarEventBody,
  type CalendarItem,
} from "../src/calendar/calendar-sync";

const NOW = new Date("2026-11-27T00:00:00Z");
const TASK: CalendarItem = {
  id: "task-1",
  title: "Write report",
  startsAt: "2026-11-30T02:00:00Z",
  endsAt: "2026-11-30T03:00:00Z",
};

function makeClient(remote: Map<string, CalendarEventBody>, calls: string[], tokens: string[]) {
  const client: CalendarClient = {
    async createEvent(token, body) {
      tokens.push(token);
      calls.push("create");
      if (remote.has(body.id)) throw new CalendarEventExistsError();
      remote.set(body.id, body);
    },
    async updateEvent(token, id, body) {
      tokens.push(token);
      calls.push("update");
      remote.set(id, { ...body, id });
    },
    async deleteEvent(token, id) {
      tokens.push(token);
      calls.push("delete");
      remote.delete(id);
    },
  };
  return client;
}

function build(
  client: CalendarClient,
  opts: { token?: string | null; mask?: boolean; horizon?: number } = {},
) {
  return new CalendarSyncService({
    client,
    map: new InMemoryEventMap(),
    accessToken: async () => (opts.token === undefined ? "tok" : opts.token),
    maskTitles: async () => opts.mask ?? false,
    horizonWeeks: async () => opts.horizon ?? 2,
    maskedTitle: () => "Busy",
  });
}

function setup(opts: { token?: string | null; mask?: boolean; horizon?: number } = {}) {
  const remote = new Map<string, CalendarEventBody>();
  const calls: string[] = [];
  const tokensSeen: string[] = [];
  const svc = build(makeClient(remote, calls, tokensSeen), opts);
  return { svc, remote, calls, tokensSeen };
}

const only = (remote: Map<string, CalendarEventBody>) => [...remote.values()][0];

describe("calendar mirror", () => {
  it("creates one event for a new task", async () => {
    const { svc, remote } = setup();
    await svc.upsert("u1", TASK, NOW);
    expect(remote.size).toBe(1);
    expect(only(remote)?.title).toBe("Write report");
  });

  it("updates and does not duplicate when a task is moved (criterion 3)", async () => {
    const { svc, remote, calls } = setup();
    await svc.upsert("u1", TASK, NOW);
    await svc.upsert(
      "u1",
      { ...TASK, startsAt: "2026-12-01T02:00:00Z", endsAt: "2026-12-01T03:00:00Z" },
      NOW,
    );
    expect(remote.size).toBe(1);
    expect(only(remote)?.startsAt).toBe("2026-12-01T02:00:00Z");
    expect(calls).toEqual(["create", "update"]);
  });

  it("makes no call when nothing changed", async () => {
    const { svc, calls } = setup();
    await svc.upsert("u1", TASK, NOW);
    await svc.upsert("u1", TASK, NOW);
    expect(calls).toEqual(["create"]);
  });

  it("recovers when the mapping was lost but the event exists", async () => {
    const remote = new Map<string, CalendarEventBody>();
    const client = makeClient(remote, [], []);
    await build(client).upsert("u1", TASK, NOW);
    // A fresh mapping table against the same remote calendar.
    await build(client).upsert("u1", { ...TASK, title: "Renamed" }, NOW);
    expect(remote.size).toBe(1);
    expect(only(remote)?.title).toBe("Renamed");
  });

  it("deletes the event when the task is removed and ignores unknown ids", async () => {
    const { svc, remote, calls } = setup();
    await svc.upsert("u1", TASK, NOW);
    await svc.remove("u1", "task-1", NOW);
    await svc.remove("u1", "task-1", NOW);
    await svc.remove("u1", "nope", NOW);
    expect(remote.size).toBe(0);
    expect(calls).toEqual(["create", "delete"]);
  });

  it("masks titles when the user chose to", async () => {
    const { svc, remote } = setup({ mask: true });
    await svc.upsert("u1", TASK, NOW);
    expect(only(remote)?.title).toBe("Busy");
  });

  it("makes no Google call without a usable token", async () => {
    const { svc, calls } = setup({ token: null });
    await svc.upsert("u1", TASK, NOW);
    await svc.remove("u1", "task-1", NOW);
    await svc.reconcile("u1", [TASK], NOW);
    expect(calls).toEqual([]);
  });

  it("skips items outside the horizon weeks", async () => {
    const { svc, calls } = setup({ horizon: 1 });
    await svc.upsert(
      "u1",
      { ...TASK, startsAt: "2027-02-01T02:00:00Z", endsAt: "2027-02-01T03:00:00Z" },
      NOW,
    );
    expect(calls).toEqual([]);
  });

  it("reconcile creates, updates and deletes so the calendar matches the schedule", async () => {
    const { svc, remote } = setup();
    await svc.upsert("u1", TASK, NOW);
    await svc.upsert("u1", { ...TASK, id: "task-2" }, NOW);
    await svc.reconcile("u1", [{ ...TASK, title: "Moved" }, { ...TASK, id: "task-3" }], NOW);
    expect(remote.size).toBe(2);
    expect([...remote.values()].map((e) => e.title).sort()).toEqual(["Moved", "Write report"]);
  });

  it("passes the token to Google but never logs it", async () => {
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const spy = (...a: unknown[]) => void lines.push(a.join(" "));
    console.log = spy;
    console.error = spy;
    console.warn = spy;
    try {
      const { svc, tokensSeen } = setup({ token: "SECRET-TOKEN" });
      await svc.upsert("u1", TASK, NOW);
      expect(tokensSeen).toEqual(["SECRET-TOKEN"]);
    } finally {
      Object.assign(console, orig);
    }
    expect(lines.join("\n")).not.toContain("SECRET-TOKEN");
  });
});
