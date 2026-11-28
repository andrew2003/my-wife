import type { PlanStore } from "./plan";

export interface DemoWeekDeps {
  store: PlanStore;
  userId: string;
  /** First day of the week, `YYYY-MM-DD`. Time is a parameter so the seed can be simulated. */
  firstDay: string;
  newId: () => string;
}

/**
 * Gives the demo user a current week so the planning, routines and review screens have a
 * week to read. Idempotent: a user that already has a week is left as it is.
 */
export function seedDemoWeek(deps: DemoWeekDeps): "seeded" | "exists" {
  const { store, userId } = deps;
  if (store.latestWeek(userId)) return "exists";
  store.addWeek({
    id: deps.newId(),
    userId,
    firstDay: deps.firstDay,
    state: "active",
    // The review screen reads a closed week, so the demo week is already announced as closed.
    closedAnnounced: true,
    reviewAnnounced: false,
  });
  return "seeded";
}
