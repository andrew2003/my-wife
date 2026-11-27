import { describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION } from "@my-wife/contracts";
import { SimClock } from "@my-wife/test-kit";
import type { PublishedEvent } from "../src/channels/channel-service";
import { InMemoryQuestionStore, QuestionService } from "../src/questions/question-service";

const ask = (id: string, expiresAt: string) => ({
  id: `evt-${id}`,
  occurredAt: "2026-11-02T00:00:00.000Z",
  userId: "u1",
  schemaVersion: EVENT_SCHEMA_VERSION,
  type: "ask.budget_category",
  payload: {
    questionId: id,
    kind: "budget_category",
    subjectRef: "txn-1",
    options: [{ value: "food", labelKey: "notify.option.food" }],
    expiresAt,
    params: {},
  },
});

function setup(failDelivery = false) {
  const clock = new SimClock("2026-11-02T00:00:00.000Z");
  const events: PublishedEvent[] = [];
  const service = new QuestionService({
    store: new InMemoryQuestionStore(),
    clock,
    defaultLocale: "en",
    publish: async (e) => void events.push(e),
    deliver: async () => {
      if (failDelivery) throw new Error("down");
    },
  });
  return { clock, events, service };
}

const expired = (events: PublishedEvent[]) =>
  events.filter((e) => e.name === "notify.question_expired");

describe("question expiry", () => {
  it("emits notify.question_expired once when time passes expiresAt", async () => {
    const { clock, events, service } = setup();
    await service.handleEvent(ask("q1", "2026-11-03T00:00:00.000Z"));
    await service.expireDue();
    expect(expired(events)).toHaveLength(0);
    await clock.advanceBy(24 * 60 * 60 * 1000);
    await service.expireDue();
    await service.expireDue();
    expect(expired(events)).toHaveLength(1);
    expect(expired(events)[0]!.payload).toEqual({
      questionId: "q1",
      sourceService: "budget",
      kind: "budget_category",
    });
  });

  it("expires inbox-only questions too", async () => {
    const { clock, events, service } = setup(true);
    await service.handleEvent(ask("q2", "2026-11-03T00:00:00.000Z"));
    await clock.advanceBy(25 * 60 * 60 * 1000);
    await service.expireDue();
    expect(expired(events)).toHaveLength(1);
  });

  it("does not expire an answered question", async () => {
    const { clock, events, service } = setup();
    await service.handleEvent(ask("q3", "2026-11-03T00:00:00.000Z"));
    expect(await service.answer("u1", "q3", "food", "web")).toBe(true);
    await clock.advanceBy(48 * 60 * 60 * 1000);
    await service.expireDue();
    expect(expired(events)).toHaveLength(0);
  });

  it("refuses a reply after expiry", async () => {
    const { clock, service } = setup();
    await service.handleEvent(ask("q4", "2026-11-03T00:00:00.000Z"));
    await clock.advanceBy(48 * 60 * 60 * 1000);
    await service.expireDue();
    expect(await service.answer("u1", "q4", "food", "web")).toBe(false);
  });
});
