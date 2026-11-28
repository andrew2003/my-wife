import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as mock } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { InboxView } from "../components/inbox-view";
import { DEFAULT_EXPRESSION_SET, defaultExpressionSettings } from "../lib/expressions";
import {
  answerInboxQuestion,
  applyAnswered,
  canAnswer,
  inboxExpressionState,
  inboxStickerKey,
  isRead,
  loadInbox,
} from "../lib/inbox";
import { NAV_ITEMS } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const QID = "22222222-2222-4222-8222-222222222222";
const question = (over: Record<string, unknown> = {}) => ({
  id: QID,
  sourceService: "budget",
  kind: "budget_category",
  options: [
    { value: "food", labelKey: "category.food" },
    { value: "fun", labelKey: "category.fun" },
  ],
  expiresAt: "2026-12-01T00:00:00.000Z",
  state: "delivered",
  ...over,
});
const items = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    class: "digest",
    messageKey: "inbox.test.hello",
    params: { name: "An" },
    question: null,
    createdAt: "2026-11-27T01:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    class: "question",
    messageKey: "inbox.test.ask",
    params: {},
    question: question(),
    createdAt: "2026-11-27T02:00:00.000Z",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    class: "question",
    messageKey: "inbox.test.ask",
    params: {},
    question: question({ id: "55555555-5555-4555-8555-555555555555", state: "answered" }),
    createdAt: "2026-11-27T03:00:00.000Z",
  },
];
const now = new Date("2026-11-27T10:00:00.000Z");

describe("inbox loading", () => {
  it("lists items from the gateway and passes filters", async () => {
    const f = mock.fn(async (_url: string) =>
      json(200, { ok: true, data: { items, nextCursor: null } }),
    );
    const res = await loadInbox({ service: "budget", state: "delivered" }, f);
    expect(res.status).toBe("ready");
    const url = String(f.mock.calls[0]![0]);
    expect(url).toContain("/api/notify/inbox?");
    expect(url).toContain("service=budget");
    expect(url).toContain("state=delivered");
  });
  it("is empty without items and error on failure or bad shape", async () => {
    const empty = await loadInbox({}, async () =>
      json(200, { ok: true, data: { items: [], nextCursor: null } }),
    );
    expect(empty.status).toBe("empty");
    expect((await loadInbox({}, async () => json(500, {}))).status).toBe("error");
    expect((await loadInbox({}, async () => json(200, { nope: 1 }))).status).toBe("error");
    const thrown = await loadInbox({}, async () => {
      throw new Error("x");
    });
    expect(thrown.status).toBe("error");
  });
});

describe("read state and actions", () => {
  it("an item is read when opened or when its question is closed", () => {
    const seen = new Set(["11111111-1111-4111-8111-111111111111"]);
    expect(isRead(items[0] as never, seen)).toBe(true);
    expect(isRead(items[1] as never, seen)).toBe(false);
    expect(isRead(items[2] as never, seen)).toBe(true);
  });
  it("only an open, unexpired question can be answered", () => {
    expect(canAnswer(items[1] as never, now)).toBe(true);
    expect(canAnswer(items[2] as never, now)).toBe(false);
    expect(canAnswer(items[0] as never, now)).toBe(false);
    expect(canAnswer(items[1] as never, new Date("2026-12-02T00:00:00.000Z"))).toBe(false);
  });
  it("posts the chosen value and reports acceptance", async () => {
    const f = mock.fn(async (_url: string, _init?: RequestInit) =>
      json(200, { ok: true, data: { state: "answered", accepted: true } }),
    );
    expect(await answerInboxQuestion(QID, "food", f)).toEqual({
      status: "answered",
      accepted: true,
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/notify/questions/answer");
    expect(JSON.parse(String(init?.body))).toEqual({ questionId: QID, value: "food" });
  });
  it("reports a failed reply and an already answered question", async () => {
    expect(await answerInboxQuestion(QID, "food", async () => json(500, {}))).toEqual({
      status: "error",
    });
    const f = async () => json(200, { ok: true, data: { state: "answered", accepted: false } });
    expect(await answerInboxQuestion(QID, "food", f)).toEqual({
      status: "answered",
      accepted: false,
    });
  });
});

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(InboxView, {
      locale: "en",
      status: "ready",
      items,
      readIds: new Set<string>(),
      now,
      timeZone: "Asia/Ho_Chi_Minh",
      filter: {},
      busyId: null,
      replyError: false,
      onFilter: () => {},
      onRefresh: () => {},
      onMarkRead: () => {},
      onAnswer: () => {},
      expressions: defaultExpressionSettings(),
      artAvailable: true,
      ...props,
    } as never),
  );

describe("inbox view", () => {
  it("lists messages with read state and answer buttons", () => {
    const html = render({ readIds: new Set(["11111111-1111-4111-8111-111111111111"]) });
    expect(html).toContain(en["inbox.state.read"]);
    expect(html).toContain(en["inbox.state.unread"]);
    expect(html).toContain(en["inbox.mark_read"]);
    expect(html).toContain("<button");
    expect(html).toContain(en["inbox.question.answered"]);
  });
  it("renders in Vietnamese", () => {
    expect(render({ locale: "vi" })).toContain(vi["inbox.state.unread"]);
  });
  it("has loading, empty and error states", () => {
    expect(render({ status: "loading" })).toContain(en["inbox.loading"]);
    expect(render({ status: "empty", items: [] })).toContain(en["inbox.empty"]);
    const err = render({ status: "error", items: [] });
    expect(err).toContain(en["inbox.error"]);
    expect(err).toContain(en["inbox.retry"]);
  });
  it("shows a reply error", () => {
    expect(render({ replyError: true })).toContain(en["inbox.error.reply"]);
  });
});

describe("inbox navigation and locales", () => {
  it("is in the navigation with labels in both locales", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/inbox")).toBe(true);
    expect(en).toHaveProperty(["nav.inbox"]);
    expect(vi).toHaveProperty(["nav.inbox"]);
  });
});

describe("stickers from the active set", () => {
  it("maps a message to an expression state", () => {
    expect(inboxExpressionState(items[0] as never, now)).toBe("news");
    expect(inboxExpressionState(items[1] as never, now)).toBe("needs_answer");
    expect(inboxExpressionState(items[2] as never, now)).toBe("task_done");
    expect(inboxExpressionState({ ...items[0], class: "urgent" } as never, now)).toBe(
      "fault_penalty",
    );
    expect(inboxExpressionState({ ...items[0], class: "timed" } as never, now)).toBe("greeting");
  });
  it("uses the active set and the user mapping", () => {
    const settings = defaultExpressionSettings();
    expect(inboxStickerKey(items[1] as never, now, settings)).toBe(`${DEFAULT_EXPRESSION_SET}-ask`);
    const blue = {
      set: "blue_face" as const,
      map: { ...settings.map, needs_answer: "love" as const },
    };
    expect(inboxStickerKey(items[1] as never, now, blue)).toBe("blue-face-love");
  });
  it("renders one sticker per message from the active set", () => {
    const html = render({});
    expect(html.match(/class="mascot-art"/g)?.length).toBe(items.length);
    expect(html).toContain("chibi-ask");
    expect(html).toContain("chibi-surprise");
    const silver = render({
      expressions: { set: "silver_face", map: defaultExpressionSettings().map },
    });
    expect(silver).toContain("silver-face-ask");
  });
  it("falls back to original art without a private art directory", () => {
    const html = render({ artAvailable: false });
    expect(html).toContain("fallback-art");
    expect(html).not.toContain("mascot-art");
  });
});

describe("inline answers", () => {
  it("shows answer chips inline for an open question only", () => {
    const html = render({});
    expect(html.match(/data-answer-option/g)?.length).toBe(2);
  });
  it("marks the question answered in place and keeps the chosen value", () => {
    const next = applyAnswered(items as never, QID, "food");
    const updated = next.find((i) => i.question?.id === QID)!;
    expect(updated.question?.state).toBe("answered");
    expect(canAnswer(updated, now)).toBe(false);
    expect(isRead(updated, new Set())).toBe(true);
    expect(next).toHaveLength(items.length);
    expect(items[1]!.question!.state).toBe("delivered");
  });
  it("shows the given answer after it was sent", () => {
    const html = render({ answers: { [QID]: "food" } });
    expect(html).toContain(en["inbox.your_answer"].replace("{value}", "food"));
  });
  it("renders a friendly empty state with art and a skeleton while loading", () => {
    const empty = render({ status: "empty", items: [] });
    expect(empty).toContain(en["inbox.empty"]);
    expect(empty).toContain("mascot-art");
    expect(render({ status: "loading" })).toContain("mw-skeleton");
  });
  it("has the new keys in both locales", () => {
    for (const key of ["inbox.your_answer", "inbox.sticker_alt", "inbox.error.title"]) {
      expect(en).toHaveProperty([key]);
      expect(vi).toHaveProperty([key]);
    }
  });
});
