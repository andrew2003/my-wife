import { describe, expect, it } from "vitest";
import { InMemoryEventMap, type CalendarItem } from "../src/calendar/calendar-sync";
import { AppleCalendarProvider, InMemoryAppleCredentialStore } from "../src/apple/apple-calendar";

const NOW = new Date("2026-11-27T00:00:00Z");
const SECRET = "test-secret-test-secret-test-secret";
const PASSWORD = "abcd-efgh-ijkl-mnop";
const TASK: CalendarItem = {
  id: "task-1",
  title: "Write report",
  startsAt: "2026-11-30T02:00:00Z",
  endsAt: "2026-11-30T03:00:00Z",
};

type Req = { method: string; url: string; headers: Record<string, string>; body: string };

function setup(opts: { consent?: boolean; mask?: boolean } = {}) {
  const remote = new Map<string, string>();
  const reqs: Req[] = [];
  const logs: string[] = [];
  const fetchFn = async (url: string, init: any) => {
    reqs.push({ method: init.method, url, headers: init.headers, body: init.body ?? "" });
    if (init.method === "MKCALENDAR") return new Response(null, { status: 201 });
    if (init.method === "PUT") {
      if (init.headers["If-None-Match"] === "*" && remote.has(url)) {
        return new Response(null, { status: 412 });
      }
      remote.set(url, init.body);
      return new Response(null, { status: 201 });
    }
    if (init.method === "DELETE") {
      remote.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  };
  const store = new InMemoryAppleCredentialStore(SECRET);
  let consent = opts.consent ?? true;
  const provider = new AppleCalendarProvider({
    fetch: fetchFn,
    credentials: store,
    consent: async () => consent,
    map: new InMemoryEventMap(),
    maskTitles: async () => opts.mask ?? false,
    horizonWeeks: async () => 2,
    maskedTitle: () => "Busy",
    log: (m) => logs.push(m),
  });
  return { provider, store, remote, reqs, logs, setConsent: (v: boolean) => (consent = v) };
}

const CREDS = {
  appleId: "me@icloud.com",
  appPassword: PASSWORD,
  calendarUrl: "https://caldav.icloud.com/123/calendars/my-wife/",
};

async function linked(opts: { consent?: boolean; mask?: boolean } = {}) {
  const s = setup(opts);
  await s.store.save("u1", CREDS);
  return s;
}

describe("apple calendar mirror", () => {
  it("creates one event for a new task and does not duplicate a move", async () => {
    const { provider, remote } = await linked();
    await provider.upsert("u1", TASK, NOW);
    expect(remote.size).toBe(1);
    expect([...remote.values()][0]).toContain("SUMMARY:Write report");
    await provider.upsert(
      "u1",
      { ...TASK, startsAt: "2026-12-01T02:00:00Z", endsAt: "2026-12-01T03:00:00Z" },
      NOW,
    );
    expect(remote.size).toBe(1);
    expect([...remote.values()][0]).toContain("DTSTART:20261201T020000Z");
  });

  it("is idempotent for an unchanged task", async () => {
    const { provider, reqs } = await linked();
    await provider.upsert("u1", TASK, NOW);
    const n = reqs.length;
    await provider.upsert("u1", TASK, NOW);
    expect(reqs.length).toBe(n);
  });

  it("deletes and reconciles", async () => {
    const { provider, remote } = await linked();
    await provider.upsert("u1", TASK, NOW);
    await provider.remove("u1", "task-1", NOW);
    expect(remote.size).toBe(0);
    await provider.upsert("u1", TASK, NOW);
    await provider.reconcile("u1", [], NOW);
    expect(remote.size).toBe(0);
  });

  it("masks titles and respects the horizon", async () => {
    const { provider, remote } = await linked({ mask: true });
    await provider.upsert("u1", TASK, NOW);
    expect([...remote.values()][0]).toContain("SUMMARY:Busy");
    expect([...remote.values()][0]).not.toContain("Write report");
    await provider.upsert("u1", { ...TASK, id: "far", startsAt: "2027-03-01T02:00:00Z" }, NOW);
    expect(remote.size).toBe(1);
  });

  it("updates the existing event instead of duplicating when the mapping is lost", async () => {
    const a = await linked();
    await a.provider.upsert("u1", TASK, NOW);
    const b = await linked();
    for (const [k, v] of a.remote) b.remote.set(k, v);
    await b.provider.upsert("u1", TASK, NOW);
    expect(b.remote.size).toBe(1);
  });

  it("makes no call when consent is revoked", async () => {
    const { provider, reqs, setConsent } = await linked();
    await provider.upsert("u1", TASK, NOW);
    const n = reqs.length;
    setConsent(false);
    await provider.upsert("u1", { ...TASK, title: "Changed" }, NOW);
    await provider.remove("u1", "task-1", NOW);
    await provider.reconcile("u1", [], NOW);
    expect(reqs.length).toBe(n);
  });

  it("makes no call when nothing is linked", async () => {
    const { provider, reqs } = setup();
    await provider.upsert("u1", TASK, NOW);
    expect(reqs.length).toBe(0);
  });

  it("stores the app password encrypted and never logs it", async () => {
    const { provider, store, reqs, logs } = await linked();
    const raw = store.rawRow("u1") ?? "";
    expect(raw).not.toContain(PASSWORD);
    expect(raw.startsWith("v1.")).toBe(true);
    expect((await store.load("u1"))?.appPassword).toBe(PASSWORD);
    await provider.upsert("u1", TASK, NOW);
    expect(reqs[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`me@icloud.com:${PASSWORD}`).toString("base64")}`,
    );
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it("does not leak the password in errors or logs when the server rejects", async () => {
    const s = await linked();
    const bad = new AppleCalendarProvider({
      fetch: async () => new Response(null, { status: 401 }),
      credentials: s.store,
      consent: async () => true,
      map: new InMemoryEventMap(),
      maskTitles: async () => false,
      horizonWeeks: async () => 2,
      maskedTitle: () => "Busy",
      log: (m) => s.logs.push(m),
    });
    const err = await bad.upsert("u1", TASK, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(PASSWORD);
    expect(s.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.logs)).not.toContain(PASSWORD);
  });
});
