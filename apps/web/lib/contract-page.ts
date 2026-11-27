import { GetSettingsResponseSchema, SETTINGS } from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Local shapes: `GET /contracts/status` and a rewards list are not in `packages/contracts` yet
 * (see docs/decisions.md, MW-155), so they are validated here instead of redeclared as API types.
 */
const StatusSchema = z.object({
  ok: z.literal(true),
  data: z
    .object({
      cycleId: z.string(),
      contractRequired: z.boolean(),
      looseningLockedUntil: z.string().nullable(),
    })
    .nullable(),
});

const RewardSchema = z.object({
  id: z.string(),
  amountVnd: z.number().int().nonnegative(),
  categoryId: z.string().nullable(),
  unlockedAt: z.string(),
});
const RewardsSchema = z.object({
  ok: z.literal(true),
  data: z.object({ rewards: z.array(RewardSchema) }),
});

export type RewardEntry = z.infer<typeof RewardSchema>;

export interface ContractPageData {
  cycleId: string;
  contractRequired: boolean;
  looseningLockedUntil: string | null;
  rewards: RewardEntry[];
  /** The user's reward rule: a clean streak of this many days unlocks this amount. */
  rule: { streakDays: number; amountVnd: number };
}

export type ContractPageResult =
  { status: "ready"; data: ContractPageData } | { status: "empty" } | { status: "error" };

async function getJson(doFetch: FetchLike, url: string): Promise<unknown | null> {
  try {
    const res = await doFetch(url, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function loadRule(doFetch: FetchLike): Promise<ContractPageData["rule"]> {
  const rule = {
    streakDays: SETTINGS["reward.clean_streak_days"].default,
    amountVnd: SETTINGS["reward.unlock_amount_vnd"].default,
  };
  const parsed = GetSettingsResponseSchema.safeParse(await getJson(doFetch, "/api/settings"));
  if (!parsed.success || !parsed.data.ok) return rule;
  const { values } = parsed.data.data;
  const days = values["reward.clean_streak_days"];
  const amount = values["reward.unlock_amount_vnd"];
  return {
    streakDays: typeof days === "number" ? days : rule.streakDays,
    amountVnd: typeof amount === "number" ? amount : rule.amountVnd,
  };
}

/**
 * Reads the contract status of the open cycle, the unlocked rewards and the reward rule. A
 * missing rewards route (the gateway has none yet) shows an empty list, not an error.
 */
export async function loadContractPage(doFetch: FetchLike = fetch): Promise<ContractPageResult> {
  const status = StatusSchema.safeParse(await getJson(doFetch, "/api/contracts/status"));
  if (!status.success) return { status: "error" };
  if (status.data.data === null) return { status: "empty" };
  const [rewardsBody, rule] = await Promise.all([
    getJson(doFetch, "/api/rewards"),
    loadRule(doFetch),
  ]);
  const rewards = RewardsSchema.safeParse(rewardsBody);
  return {
    status: "ready",
    data: { ...status.data.data, rewards: rewards.success ? rewards.data.data.rewards : [], rule },
  };
}

/** Signs the contract of one cycle; signing is idempotent in rules. True when accepted. */
export async function signCycleContract(
  cycleId: string,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await doFetch("/api/contracts/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
