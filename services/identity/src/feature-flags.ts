import type { FeatureFlagSchema } from "@my-wife/contracts";

export type FeatureFlag = ReturnType<typeof FeatureFlagSchema.parse>;

/** Per-user feature switches set by admins; in memory until the Drizzle store lands. */
export interface FeatureFlagStore {
  /** Absent means the feature is enabled (the default). */
  get(userId: string, flag: FeatureFlag): Promise<boolean | undefined>;
  set(userId: string, flag: FeatureFlag, enabled: boolean): Promise<void>;
  list(userId: string): Promise<Partial<Record<FeatureFlag, boolean>>>;
}

export function createFeatureFlagStore(): FeatureFlagStore {
  const rows = new Map<string, Map<FeatureFlag, boolean>>();
  return {
    async get(userId, flag) {
      return rows.get(userId)?.get(flag);
    },
    async set(userId, flag, enabled) {
      const m = rows.get(userId) ?? new Map<FeatureFlag, boolean>();
      m.set(flag, enabled);
      rows.set(userId, m);
    },
    async list(userId) {
      return Object.fromEntries(rows.get(userId) ?? []);
    },
  };
}

/** Locale key (in the `vi` and `en` web locale files) of the notice shown for a disabled feature. */
export const featureDisabledNoticeKey = (flag: FeatureFlag) => `feature.disabled.${flag}`;
