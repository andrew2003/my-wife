import { SETTINGS } from "@my-wife/contracts";
import type { RulesClient, SummaryClient } from "../clients";
import type { RulesPorts } from "./rules";
import type { SummaryPorts } from "./summary";

export interface SummaryPortsDeps {
  client: SummaryClient;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
}

/** Connects the summary commands to the existing schedule, budget and rules read routes. */
export function createSummaryPorts(deps: SummaryPortsDeps): SummaryPorts {
  return {
    ...deps.client,
    async timeZone(userId) {
      const def = SETTINGS["calendar.time_zone"];
      try {
        const parsed = def.schema.safeParse(
          (await deps.readSettings(userId))["calendar.time_zone"],
        );
        return parsed.success ? parsed.data : def.default;
      } catch {
        return def.default;
      }
    },
  };
}

/** Connects `/appeal` and `/reason` to the rules routes. */
export const createRulesPorts = (client: RulesClient): RulesPorts => client;
