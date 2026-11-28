import { SETTINGS } from "@my-wife/contracts";
import type { BudgetClient, ScheduleClient } from "../clients";
import type { MemoryService } from "../memory";
import type { CapturePorts } from "./capture";

export interface CapturePortsDeps {
  budget: BudgetClient;
  schedule: ScheduleClient;
  memory: Pick<MemoryService, "remember" | "findByText" | "delete">;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
}

/** Connects the capture commands to the existing budget, schedule and memory write paths. */
export function createCapturePorts(deps: CapturePortsDeps): CapturePorts {
  return {
    recordSpend: async (userId, input) => void (await deps.budget.recordCashExpense(userId, input)),
    createTask: async (userId, input) => void (await deps.schedule.createTask(userId, input)),
    remember: (userId, fact, now) => deps.memory.remember(userId, fact, now),
    findMemories: (userId, text) => deps.memory.findByText(userId, text),
    forget: (userId, memoryId) => deps.memory.delete(userId, memoryId),
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
