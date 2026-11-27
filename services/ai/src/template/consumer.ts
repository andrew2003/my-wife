import { parseEvent } from "@my-wife/contracts";
import { subject } from "@my-wife/service-kit";
import type { RawEmail, TemplateReadService } from "./template-read-service";

export const TEMPLATE_READ_REQUESTED = "template.read_requested";
export const AI_QUEUE_GROUP = "ai";

/** Handles one raw message; returns true when it was a valid request and was processed. */
export async function handleTemplateReadRequested(
  service: TemplateReadService,
  input: unknown,
): Promise<boolean> {
  const parsed = parseEvent(input);
  if (!parsed.success || parsed.data.type !== TEMPLATE_READ_REQUESTED) return false;
  const { receiptId, templateFingerprint } = parsed.data.payload as {
    receiptId: string;
    templateFingerprint: string;
  };
  await service.read(parsed.data.userId, { receiptId, templateFingerprint });
  return true;
}

export interface SubscribeLike {
  subscribe(subject: string, opts: { queue: string }): AsyncIterable<{ string(): string }>;
}

/** Core NATS consumer under a queue group; a bad message is logged and dropped. */
export async function runTemplateReadConsumer(opts: {
  nats: SubscribeLike;
  prefix: string;
  service: TemplateReadService;
  log: { warn(o: object, m: string): void };
}): Promise<void> {
  const sub = opts.nats.subscribe(subject(opts.prefix, TEMPLATE_READ_REQUESTED), {
    queue: AI_QUEUE_GROUP,
  });
  for await (const msg of sub) {
    try {
      if (!(await handleTemplateReadRequested(opts.service, JSON.parse(msg.string()))))
        opts.log.warn({}, "dropped invalid template read request");
    } catch (error) {
      opts.log.warn(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "template read handler failed",
      );
    }
  }
}

/**
 * Reads the raw mail from ingest over internal REST (`x-user-id` header). Ingest has no such
 * route yet; see docs/decisions.md. Any failure returns null.
 */
export function createEmailFetcher(
  ingestUrl: string,
  fetchFn: typeof fetch = fetch,
): (userId: string, receiptId: string) => Promise<RawEmail | null> {
  return async (userId, receiptId) => {
    try {
      const res = await fetchFn(
        `${ingestUrl}/receipts/${encodeURIComponent(receiptId)}/raw-email`,
        { headers: { "x-user-id": userId } },
      );
      if (!res.ok) return null;
      const b = (await res.json()) as { ok?: boolean; data?: Partial<RawEmail> };
      const d = b.data;
      return b.ok &&
        typeof d?.sender === "string" &&
        typeof d.subject === "string" &&
        typeof d.body === "string"
        ? { sender: d.sender, subject: d.subject, body: d.body }
        : null;
    } catch {
      return null;
    }
  };
}
