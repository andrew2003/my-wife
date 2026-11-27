import { LunarRangeError, solarToLunar, type LunarDate } from "./lunar";

export interface CalendarCell {
  /** `YYYY-MM-DD`. */
  iso: string;
  solarDay: number;
  /** Null when the year is outside the supported lunar range. */
  lunar: LunarDate | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Month grid with weeks starting on Monday; `null` pads days outside the month. */
export function buildMonthGrid(year: number, month: number): (CalendarCell | null)[][] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const leading = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (CalendarCell | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    let lunar: LunarDate | null = null;
    try {
      lunar = solarToLunar(iso);
    } catch (error) {
      if (!(error instanceof LunarRangeError)) throw error;
    }
    cells.push({ iso, solarDay: day, lunar });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

export function shiftMonth(year: number, month: number, delta: number) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Short lunar label: `day/month`, with `L` after the month for a leap month. */
export function lunarLabel(lunar: LunarDate): string {
  return `${lunar.day}/${lunar.month}${lunar.leap ? "L" : ""}`;
}
