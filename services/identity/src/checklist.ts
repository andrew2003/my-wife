/**
 * Real checks that identity cannot answer from its own data. Each is optional: without it the
 * item stays pending and is reported as not checked. A check that throws counts the same.
 */
export type ChecklistChecks = {
  /** A chat channel is linked and its test message was delivered (owned by `notify`). */
  channelLinked?: (userId: string) => Promise<boolean>;
  /** Forwarded bank mail was received and passed DKIM (owned by `ingest`). */
  forwardingVerified?: (userId: string) => Promise<boolean>;
};

/** The setup checklist steps of spec 40 section 7, in display order. */
export const CHECKLIST_STEPS = [
  "connect_channel",
  "llm_key",
  "mail_forwarding",
  "notifications_camera_install",
  "do_not_disturb",
] as const;

export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];
export type ChecklistStatus = "done" | "skipped" | "pending";

export type ChecklistItem = {
  step: ChecklistStep;
  status: ChecklistStatus;
  /** True when the status came from a real check, false when it only reflects the recorded step. */
  checked: boolean;
};

/** Pure: a passed real check wins; otherwise the recorded step decides (done, skipped, pending). */
export function resolveItem(
  step: ChecklistStep,
  check: boolean | undefined,
  recorded: { skipped: boolean } | undefined,
): ChecklistItem {
  const checked = check !== undefined;
  if (check === true) return { step, status: "done", checked };
  if (recorded?.skipped) return { step, status: "skipped", checked };
  // Only an item with no real check trusts a recorded "done"; a failed check stays pending.
  if (recorded && check === undefined) return { step, status: "done", checked };
  return { step, status: "pending", checked };
}

/** Runs a check; an unwired or failing check yields undefined (not checked). */
export async function runCheck(
  check: ((userId: string) => Promise<boolean>) | undefined,
  userId: string,
): Promise<boolean | undefined> {
  if (!check) return undefined;
  try {
    return await check(userId);
  } catch {
    return undefined;
  }
}
