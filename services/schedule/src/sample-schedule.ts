import { SETTINGS, type SettingKey } from "@my-wife/contracts";

/** Setup answers this generator reads; they are stored as user settings (MW-011). */
export type SampleAnswers = Partial<Record<SettingKey, unknown>>;

export interface SampleBlock {
  /** Locale key of the block title; rendering happens in the client. */
  titleKey: string;
  start: string;
  end: string;
  /** Type column of the standard day template. */
  type: "routine" | "daily_rhythm" | "work";
  /** Every time of the sample schedule is editable. */
  editable: true;
}

/** Standard day template (docs/spec/40-identity-onboarding.md section 7), in minutes from midnight. */
const TEMPLATE_WAKE_MINUTES = 6 * 60;
const STANDARD = [
  { key: "wake", from: 360, to: 360, type: "routine" },
  { key: "hygiene", from: 360, to: 450, type: "routine" },
  { key: "top_three", from: 450, to: 465, type: "daily_rhythm" },
  { key: "deep_work", from: 480, to: 720, type: "work" },
  { key: "lunch", from: 720, to: 810, type: "routine" },
  { key: "work", from: 810, to: 1050, type: "work" },
  { key: "exercise_dinner", from: 1050, to: 1170, type: "routine" },
  { key: "study", from: 1170, to: 1290, type: "work" },
  { key: "reflection", from: 1290, to: 1320, type: "daily_rhythm" },
] as const;
/** Blocks of the morning chain move with the wake time; the rest keep their standard time. */
const MORNING = new Set<string>(["wake", "hygiene", "top_three", "deep_work"]);

const toMinutes = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const toTime = (minutes: number): string => {
  const m = Math.min(Math.max(minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

function timeSetting(answers: SampleAnswers, key: SettingKey): string {
  const v = answers[key];
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
    ? v
    : (SETTINGS[key].default as string);
}

/**
 * Builds the sample day. Without answers it is the standard template; wake and sleep answers
 * move the routine blocks. Pure; defaults come from the settings registry.
 */
export function buildSampleDay(answers: SampleAnswers): SampleBlock[] {
  const wake = toMinutes(timeSetting(answers, "routine.wake.time"));
  const shift = wake - TEMPLATE_WAKE_MINUTES;
  const day: SampleBlock[] = STANDARD.map((b) => {
    const moves = MORNING.has(b.key);
    const from = moves ? b.from + shift : b.from;
    // Deep work ends at lunch; only its start follows the wake time.
    const to = moves && b.key !== "deep_work" ? b.to + shift : b.to;
    return {
      titleKey: `schedule.sample.${b.key}`,
      start: toTime(from),
      end: toTime(Math.max(to, from)),
      type: b.type,
      editable: true,
    };
  });
  const sleep = timeSetting(answers, "routine.sleep.start");
  day.push({
    titleKey: "schedule.sample.sleep",
    start: sleep,
    end: sleep,
    type: "routine",
    editable: true,
  });
  return day;
}
