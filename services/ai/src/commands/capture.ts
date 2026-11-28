import type { CommandResultStatus, MessageRef } from "@my-wife/contracts";
import { resolveDay } from "../chat/capture";

/**
 * What the capture commands act on. Each port wraps an existing write path: the budget cash
 * spend route, the schedule task route and the memory service of this service. Nothing here
 * adds a new write path, and none of it moves money.
 */
export interface CapturePorts {
  recordSpend(userId: string, input: { amountVnd: number; note?: string }): Promise<void>;
  createTask(userId: string, input: { title: string; day: string }): Promise<void>;
  /** False when the fact was dropped (blank, too long or already known). */
  remember(userId: string, fact: string, now: Date): Promise<boolean>;
  /** The user's confirmed memories whose text contains `text`, case-insensitively. */
  findMemories(userId: string, text: string): Promise<{ id: string; fact: string }[]>;
  forget(userId: string, memoryId: string): Promise<boolean>;
  timeZone(userId: string): Promise<string>;
}

export interface CaptureOutcome {
  status: CommandResultStatus;
  reply: MessageRef;
  reason?: "invalid_args" | "needs_confirmation" | "not_allowed";
}

export interface CaptureContext {
  userId: string;
  args: string[];
  capture: CapturePorts | undefined;
  now: Date;
}

const ok = (key: string, params: MessageRef["params"] = {}): CaptureOutcome => ({
  status: "ok",
  reply: { key, params },
});
const invalid = (key: string, params: MessageRef["params"] = {}): CaptureOutcome => ({
  status: "refused",
  reply: { key, params },
  reason: "invalid_args",
});
const failed = (): CaptureOutcome => ({
  status: "refused",
  reply: { key: "commands.capture.failed", params: {} },
  reason: "not_allowed",
});
const unavailable = (): CaptureOutcome => ({
  status: "refused",
  reply: { key: "commands.not_available", params: {} },
  reason: "not_allowed",
});

/**
 * Reads an integer VND amount: plain digits, dot or comma thousands groups (`50.000`,
 * `1,500,000`) or a `k` suffix for thousands (`45k`). Anything else, zero and fractions give null.
 */
export function parseAmountVnd(raw: string): number | null {
  const text = raw.trim();
  let value: number;
  if (/^\d+k$/i.test(text)) value = Number(text.slice(0, -1)) * 1000;
  else if (/^\d{1,3}([.,]\d{3})+$/.test(text)) value = Number(text.replace(/[.,]/g, ""));
  else if (/^\d+$/.test(text)) value = Number(text);
  else return null;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

async function guarded(run: () => Promise<CaptureOutcome>): Promise<CaptureOutcome> {
  try {
    return await run();
  } catch {
    // Never echo the error: it could carry user text.
    return failed();
  }
}

export const CAPTURE_HANDLERS: Record<string, (ctx: CaptureContext) => Promise<CaptureOutcome>> = {
  async spend({ capture, userId, args }) {
    if (!capture) return unavailable();
    const amountVnd = parseAmountVnd(args[0] ?? "");
    if (amountVnd === null) return invalid("commands.spend.usage");
    const note = args.slice(1).join(" ");
    return guarded(async () => {
      await capture.recordSpend(userId, note ? { amountVnd, note } : { amountVnd });
      return ok("commands.spend.recorded", { amount: amountVnd, note });
    });
  },
  async task({ capture, userId, args, now }) {
    if (!capture) return unavailable();
    return guarded(async () => {
      const [first = "", ...rest] = args;
      const word = first.toLowerCase();
      const isDay = word === "today" || word === "tomorrow" || ISO_DAY.test(word);
      const zone = await capture.timeZone(userId);
      const day = resolveDay(isDay ? word : "today", now, zone);
      const title = (isDay ? rest : args).join(" ");
      if (!day || title.length === 0) return invalid("commands.task.usage");
      await capture.createTask(userId, { title, day });
      return ok("commands.task.created", { title, day });
    });
  },
  async remember({ capture, userId, args, now }) {
    if (!capture) return unavailable();
    const fact = args.join(" ");
    if (fact.length === 0) return invalid("commands.remember.usage");
    return guarded(async () =>
      (await capture.remember(userId, fact, now))
        ? ok("commands.remember.saved", { fact })
        : invalid("commands.remember.dropped"),
    );
  },
  async forget({ capture, userId, args }) {
    if (!capture) return unavailable();
    const confirmed = args[0]?.toLowerCase() === "confirm";
    const text = (confirmed ? args.slice(1) : args).join(" ");
    if (text.length === 0) return invalid("commands.forget.usage");
    return guarded(async () => {
      const matches = await capture.findMemories(userId, text);
      const [only] = matches;
      if (!only) return invalid("commands.forget.none");
      if (matches.length > 1)
        return invalid("commands.forget.ambiguous", { count: matches.length });
      if (!confirmed)
        return {
          status: "needs_confirmation",
          reply: { key: "commands.forget.confirm", params: { fact: only.fact, text } },
          reason: "needs_confirmation",
        };
      return (await capture.forget(userId, only.id))
        ? ok("commands.forget.done", { fact: only.fact })
        : invalid("commands.forget.none");
    });
  },
};
