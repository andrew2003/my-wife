import type { CaptureOutcome } from "./capture";

/**
 * What `/appeal` and `/reason` act on. Both wrap the rules routes: the fault list (read) and
 * the open-appeal write. Rules decides every outcome; the model is never involved and no
 * penalty or fault point is changed from here.
 */
export interface RulesPorts {
  /** Newest first. */
  latestFaults(
    userId: string,
    limit: number,
  ): Promise<
    {
      id: string;
      type: string;
      status: string;
      points: number;
      occurredAt: string;
      systemCause: string | null;
    }[]
  >;
  openAppeal(
    userId: string,
    input: { subjectId: string; reasonText: string },
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface RulesContext {
  userId: string;
  args: string[];
  rules: RulesPorts | undefined;
}

/** How many recent faults are looked at to find the one to appeal. */
const RECENT_FAULTS = 20;
/** Statuses where an appeal makes sense by default; rules still decides. */
const APPEALABLE = new Set(["pending_reason", "recorded"]);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refused = (
  key: string,
  reason: NonNullable<CaptureOutcome["reason"]>,
  params: CaptureOutcome["reply"]["params"] = {},
): CaptureOutcome => ({ status: "refused", reply: { key, params }, reason });

const unavailable = (): CaptureOutcome => refused("commands.not_available", "not_allowed");
const failed = (): CaptureOutcome => refused("commands.capture.failed", "not_allowed");

async function guarded(run: () => Promise<CaptureOutcome>): Promise<CaptureOutcome> {
  try {
    return await run();
  } catch {
    // Never echo the error: it could carry user text.
    return failed();
  }
}

export const RULES_HANDLERS: Record<string, (ctx: RulesContext) => Promise<CaptureOutcome>> = {
  /** `/appeal [fault id] <reason>`: without an id the newest appealable fault is used. */
  async appeal({ rules, userId, args }) {
    if (!rules) return unavailable();
    const [first = "", ...rest] = args;
    const explicit = ID_PATTERN.test(first) ? first : null;
    const reasonText = (explicit ? rest : args).join(" ");
    if (reasonText.length === 0) return refused("commands.appeal.usage", "invalid_args");
    return guarded(async () => {
      let subjectId = explicit;
      if (!subjectId) {
        const faults = await rules.latestFaults(userId, RECENT_FAULTS);
        subjectId = faults.find((f) => APPEALABLE.has(f.status))?.id ?? null;
      }
      if (!subjectId) return refused("commands.appeal.none", "invalid_args");
      const result = await rules.openAppeal(userId, { subjectId, reasonText });
      if (!result.ok) return refused("commands.appeal.refused", "not_allowed");
      return { status: "ok", reply: { key: "commands.appeal.opened", params: {} } };
    });
  },
  /** `/reason`: shows where the newest fault stands. Giving a reason happens in the app. */
  async reason({ rules, userId, args }) {
    if (!rules) return unavailable();
    if (args.length > 0) return refused("commands.reason.use_app", "not_allowed");
    return guarded(async (): Promise<CaptureOutcome> => {
      const [latest] = await rules.latestFaults(userId, 1);
      if (!latest) return { status: "ok", reply: { key: "commands.reason.none", params: {} } };
      return {
        status: "ok",
        reply: {
          key: "commands.reason.show",
          params: {
            type: latest.type,
            status: latest.status,
            points: latest.points,
            cause: latest.systemCause ?? "-",
          },
        },
      };
    });
  },
};
