import type { SettingKey } from "@my-wife/contracts";

/**
 * A starter pack: a named set of setting values chosen during onboarding (spec 40 section 7).
 * Every value is only a default for that kind of user; each stays editable in settings.
 * Names and descriptions are locale keys in the web `vi` and `en` files, never inline text.
 * Sleep and meals stay at `track` and wake-up at `remind` (the registry defaults), so no pack
 * sets a routine level.
 */
export type StarterPack = {
  id: string;
  nameKey: string;
  descriptionKey: string;
  settings: Partial<Record<SettingKey, unknown>>;
};

export const STARTER_PACKS: readonly StarterPack[] = [
  {
    id: "student",
    nameKey: "onboarding.pack.student.name",
    descriptionKey: "onboarding.pack.student.description",
    settings: {
      "routine.wake.time": "06:30",
      "routine.sleep.start": "23:30",
      "schedule.morning_pick_time": "08:00",
      "schedule.evening_reflection_time": "22:00",
      "schedule.pomodoro_work_minutes": 25,
      "budget.cycle_weeks": 4,
      "budget.weekly_limit_rounding_vnd": 1000,
      "budget.tolerance_min_vnd": 5000,
    },
  },
  {
    id: "regular_worker",
    nameKey: "onboarding.pack.regular_worker.name",
    descriptionKey: "onboarding.pack.regular_worker.description",
    settings: {
      "routine.wake.time": "06:00",
      "routine.sleep.start": "23:00",
      "schedule.morning_pick_time": "07:30",
      "schedule.evening_reflection_time": "21:30",
      "schedule.pomodoro_work_minutes": 50,
      "schedule.pomodoro_break_minutes": 10,
      "budget.cycle_weeks": 4,
    },
  },
  {
    id: "freelancer",
    nameKey: "onboarding.pack.freelancer.name",
    descriptionKey: "onboarding.pack.freelancer.description",
    settings: {
      "routine.wake.time": "07:00",
      "routine.sleep.start": "00:00",
      "schedule.morning_pick_time": "09:00",
      "schedule.evening_reflection_time": "22:30",
      "schedule.pomodoro_work_minutes": 45,
      "schedule.pomodoro_break_minutes": 10,
      "budget.cycle_weeks": 2,
      "budget.income_ratio_percent": 80,
      "budget.tolerance_percent": 10,
    },
  },
];
