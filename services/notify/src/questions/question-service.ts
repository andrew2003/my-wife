import {
  EVENT_REGISTRY,
  QuestionKindSchema,
  ServiceNameSchema,
  notifyEvents,
  parseEvent,
  type AskPayload,
  type Locale,
  type OutboundMessage,
  type Question,
  type QuestionState,
} from "@my-wife/contracts";
import type { PublishedEvent } from "../channels/channel-service";

export interface StoredQuestion {
  userId: string;
  question: Question;
}

export interface QuestionStore {
  /** Returns false when a question with this id already exists (redelivery). */
  create(record: StoredQuestion): boolean;
  get(questionId: string): StoredQuestion | undefined;
  /** Atomic compare and set; returns false when the state was not `from`. */
  transition(questionId: string, from: QuestionState[], to: QuestionState): boolean;
}

export class InMemoryQuestionStore implements QuestionStore {
  private readonly records = new Map<string, StoredQuestion>();
  create(record: StoredQuestion): boolean {
    if (this.records.has(record.question.id)) return false;
    this.records.set(record.question.id, record);
    return true;
  }
  get(questionId: string) {
    return this.records.get(questionId);
  }
  transition(questionId: string, from: QuestionState[], to: QuestionState): boolean {
    const record = this.records.get(questionId);
    if (!record || !from.includes(record.question.state)) return false;
    record.question = { ...record.question, state: to };
    return true;
  }
}

export interface QuestionServiceDeps {
  store: QuestionStore;
  clock: { now(): Date };
  defaultLocale: Locale;
  publish: (event: PublishedEvent) => Promise<void>;
  deliver: (userId: string, message: OutboundMessage, question: Question) => Promise<void>;
}

const OPEN_STATES: QuestionState[] = ["delivered", "delivered_inbox_only"];

/** Questions with quick-reply buttons; the first valid reply wins (spec 31, section 3). */
export class QuestionService {
  constructor(private readonly deps: QuestionServiceDeps) {}

  /**
   * Consumes any event. Only `ask.*` creates a question; every other subject is
   * ignored here, so `anomaly.opened` and friends never reach the chat as a question.
   */
  async handleEvent(raw: unknown): Promise<void> {
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !type.startsWith("ask.")) return;
    const parsed = parseEvent(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    const ask = event.payload as AskPayload;
    const kind = QuestionKindSchema.safeParse(ask.kind);
    const publisher = ServiceNameSchema.parse(EVENT_REGISTRY[event.type].publisher);

    const question: Question = {
      id: ask.questionId,
      sourceService: publisher,
      kind: kind.success ? kind.data : "other",
      options: ask.options,
      expiresAt: ask.expiresAt,
      state: "created",
    };
    if (!this.deps.store.create({ userId: event.userId, question })) return;

    const message: OutboundMessage = {
      id: `question-${question.id}`,
      class: "question",
      message: { key: `notify.question.${question.kind}`, params: ask.params },
      locale: this.deps.defaultLocale,
      sourceService: publisher,
      isWakeUp: false,
      createdAt: this.deps.clock.now().toISOString(),
    };
    try {
      await this.deps.deliver(event.userId, message, question);
      this.deps.store.transition(question.id, ["created"], "delivered");
    } catch {
      // Chat delivery failed: the question stays usable from the web inbox.
      this.deps.store.transition(question.id, ["created"], "delivered_inbox_only");
    }
  }

  /** Records a reply. Returns true only for the reply that answered the question. */
  async answer(
    userId: string,
    questionId: string,
    value: string,
    via: "chat" | "web",
    answeredAt: string = this.deps.clock.now().toISOString(),
    context?: PublishedEvent["context"],
  ): Promise<boolean> {
    const record = this.deps.store.get(questionId);
    if (!record || record.userId !== userId) return false;
    const { question } = record;
    if (!question.options.some((o) => o.value === value)) return false;
    if (this.deps.clock.now().getTime() >= Date.parse(question.expiresAt)) return false;
    if (!this.deps.store.transition(questionId, OPEN_STATES, "answered")) return false;
    try {
      await this.deps.publish({
        name: "notify.reply_received",
        payload: notifyEvents["notify.reply_received"].parse({
          questionId,
          sourceService: question.sourceService,
          kind: question.kind,
          value,
          answeredAt,
          via,
        }),
        context,
      });
    } catch (err) {
      // Release the claim so a later tap can retry the publish.
      this.deps.store.transition(questionId, ["answered"], question.state);
      throw err;
    }
    return true;
  }
}
