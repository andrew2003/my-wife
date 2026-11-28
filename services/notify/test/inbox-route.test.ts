import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { InboxResponseSchema, type OutboundMessage } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryInbox } from "../src/dispatch/dispatcher";
import { InMemoryQuestionStore } from "../src/questions/question-service";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "demo-user";
const OTHER = "someone-else";

function message(n: number, over: Partial<OutboundMessage> = {}): OutboundMessage {
  const minute = String(n % 60).padStart(2, "0");
  return {
    id: `m${n}`,
    class: "digest",
    message: { key: "notify.digest.morning", params: { count: n } },
    locale: "vi",
    sourceService: "schedule",
    isWakeUp: false,
    createdAt: `2026-11-${String((n % 20) + 1).padStart(2, "0")}T00:${minute}:00.000Z`,
    ...over,
  };
}

async function setup(count: number) {
  const inbox = new InMemoryInbox();
  const questions = new InMemoryQuestionStore();
  // Added out of order on purpose: page order must not depend on insertion order.
  for (let n = count; n >= 1; n--) {
    await inbox.add(USER, { message: message(n), pendingDigest: false });
  }
  await inbox.add(OTHER, { message: message(900), pendingDigest: false });
  return { app: createApp(config, { inbox, questionStore: questions }), inbox, questions };
}

type App = Awaited<ReturnType<typeof setup>>["app"];
const get = (app: App, url: string, user: string | null = USER) =>
  app.inject({ method: "GET", url, headers: user ? { "x-user-id": user } : {} });

describe("GET /inbox", () => {
  it("requires the forwarded user id", async () => {
    expect((await get((await setup(1)).app, "/inbox", null)).statusCode).toBe(401);
  });

  it("returns a body that parses with the shared schema, own items only", async () => {
    const { app } = await setup(3);
    const res = await get(app, "/inbox");
    expect(res.statusCode).toBe(200);
    const body = InboxResponseSchema.parse(res.json());
    if (!body.ok) throw new Error("expected ok");
    expect(body.data.items).toHaveLength(3);
    expect(body.data.items.map((i) => i.id)).not.toContain("m900");
    expect(body.data.items[0]).toMatchObject({
      class: "digest",
      messageKey: "notify.digest.morning",
      question: null,
    });
  });

  it("joins the question of a question message and filters", async () => {
    const { app, inbox, questions } = await setup(0);
    questions.create({
      userId: USER,
      question: {
        id: "q1",
        sourceService: "budget",
        kind: "budget_category",
        options: [{ value: "food", labelKey: "o.food" }],
        expiresAt: "2026-12-01T00:00:00.000Z",
        state: "delivered",
      },
    });
    await inbox.add(USER, {
      message: message(1, { id: "question-q1", class: "question", sourceService: "budget" }),
      pendingDigest: false,
    });
    const body = (await get(app, "/inbox?state=delivered")).json();
    expect(InboxResponseSchema.parse(body)).toMatchObject({ ok: true });
    expect(body.data.items[0].question.id).toBe("q1");
    expect((await get(app, "/inbox?state=answered")).json().data.items).toHaveLength(0);
    expect((await get(app, "/inbox?service=schedule")).json().data.items).toHaveLength(0);
    expect((await get(app, "/inbox?service=budget")).json().data.items).toHaveLength(1);
  });

  it("paginates newest first without gaps or repeats", async () => {
    const { app } = await setup(45);
    const seen: string[] = [];
    let url = "/inbox?limit=20";
    for (let i = 0; i < 5; i++) {
      const body = (await get(app, url)).json();
      expect(body.data.items.length).toBeLessThanOrEqual(20);
      seen.push(...body.data.items.map((x: { id: string }) => x.id));
      if (body.data.nextCursor === null) break;
      url = `/inbox?limit=20&cursor=${body.data.nextCursor}`;
    }
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    const all = (await get(app, "/inbox?limit=100")).json().data.items;
    const dates = all.map((x: { createdAt: string }) => x.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("caps the page size and rejects bad input", async () => {
    const { app } = await setup(120);
    expect((await get(app, "/inbox?limit=500")).json().data.items).toHaveLength(100);
    expect((await get(app, "/inbox")).json().data.items).toHaveLength(50);
    expect((await get(app, "/inbox?limit=0")).statusCode).toBe(400);
    expect((await get(app, "/inbox?cursor=!!")).statusCode).toBe(400);
    expect((await get(app, "/inbox?state=bogus")).statusCode).toBe(400);
  });

  it("serves pages from a per-user ordered index", async () => {
    const { inbox } = await setup(30);
    const page = await inbox.page(USER, { limit: 5, after: null });
    expect(page.items).toHaveLength(5);
    expect(page.next).not.toBeNull();
  });
});
