import {
  AnswerQuestionResponseSchema,
  InboxItemSchema,
  InboxResponseSchema,
  type QuestionState,
} from "@my-wife/contracts";
import type { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type InboxItem = z.infer<typeof InboxItemSchema>;

export interface InboxFilter {
  service?: string;
  state?: QuestionState;
}

export type InboxResult =
  { status: "ready"; items: InboxItem[] } | { status: "empty" } | { status: "error" };

export type AnswerResult = { status: "answered"; accepted: boolean } | { status: "error" };

const OPEN_STATES: readonly QuestionState[] = ["created", "delivered", "delivered_inbox_only"];

/**
 * The contract has no read flag, so read state is kept per device in the
 * browser. A question that is no longer open needs no attention, so it counts
 * as read.
 */
export function isRead(item: InboxItem, readIds: ReadonlySet<string>): boolean {
  if (readIds.has(item.id)) return true;
  return item.question !== null && !OPEN_STATES.includes(item.question.state);
}

/** Buttons are usable only for an open question that has not expired. */
export function canAnswer(item: InboxItem, now: Date): boolean {
  const q = item.question;
  if (q === null || !OPEN_STATES.includes(q.state)) return false;
  return new Date(q.expiresAt).getTime() > now.getTime();
}

/** Reads the inbox through the gateway, newest first. */
export async function loadInbox(
  filter: InboxFilter,
  doFetch: FetchLike = fetch,
): Promise<InboxResult> {
  const params = new URLSearchParams();
  if (filter.service) params.set("service", filter.service);
  if (filter.state) params.set("state", filter.state);
  try {
    const res = await doFetch(`/api/notify/inbox?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = InboxResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    const items = [...parsed.data.data.items].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return items.length === 0 ? { status: "empty" } : { status: "ready", items };
  } catch {
    return { status: "error" };
  }
}

/** Replies to a question from the web; the first reply from any channel wins. */
export async function answerInboxQuestion(
  questionId: string,
  value: string,
  doFetch: FetchLike = fetch,
): Promise<AnswerResult> {
  try {
    const res = await doFetch("/api/notify/questions/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId, value }),
    });
    if (!res.ok) return { status: "error" };
    const parsed = AnswerQuestionResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    return { status: "answered", accepted: parsed.data.data.accepted };
  } catch {
    return { status: "error" };
  }
}

const STORAGE_KEY = "inbox.read_ids";

export function loadReadIds(storage: Pick<Storage, "getItem"> | undefined): Set<string> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveReadIds(storage: Pick<Storage, "setItem"> | undefined, ids: Set<string>): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage may be full or blocked; read state then lasts for this visit only.
  }
}
