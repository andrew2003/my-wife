import { CreateTaskRequestSchema } from "@my-wife/contracts";
import { postJson } from "./http";

/** The schedule route that creates a task; `/task` and the web use the same one. */
export const CREATE_TASK_PATH = "/tasks";

export interface NewTaskInput {
  title: string;
  /** ISO date, already resolved by code. */
  day: string;
  estimatedMinutes?: number;
}

export interface ScheduleClient {
  createTask(userId: string, input: NewTaskInput): Promise<unknown>;
}

export function createScheduleClient(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): ScheduleClient {
  return {
    async createTask(userId, input) {
      // A chat task is plain: no monitoring, a desk task. The service fills a missing duration
      // from the user setting `schedule.task_default_minutes`.
      const body = CreateTaskRequestSchema.parse({
        title: input.title,
        day: input.day,
        monitoringProfile: "none",
        kind: "desk",
        ...(input.estimatedMinutes ? { estimatedMinutes: input.estimatedMinutes } : {}),
      });
      return postJson(fetchFn, "schedule", `${baseUrl}${CREATE_TASK_PATH}`, userId, body);
    },
  };
}
