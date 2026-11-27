/**
 * Pure Vietnamese lunisolar calendar conversion (Ho Ngoc Duc algorithm).
 * Dates are `YYYY-MM-DD` strings already in the user's local zone (`calendar.time_zone`), so the
 * functions take no clock. The astronomical computation uses UTC+7, which defines the Vietnamese
 * calendar itself; it is not a user setting.
 */

export interface LunarDate {
  year: number;
  /** 1 to 12. */
  month: number;
  /** 1 to 30. */
  day: number;
  /** True for the leap month that repeats `month`. */
  leap: boolean;
}

/** Years the conversion is supported for (inclusive). Outside this range a typed error is thrown. */
export const LUNAR_MIN_YEAR = 1900;
export const LUNAR_MAX_YEAR = 2100;

export class LunarRangeError extends Error {
  readonly code = "schedule.lunar_out_of_range";
  constructor(message: string) {
    super(message);
    this.name = "LunarRangeError";
  }
}

const VIETNAM_UTC_OFFSET = 7;
const SYNODIC_MONTH = 29.530588853;
const EPOCH_JD = 2415021.076998695;
const RAD = Math.PI / 180;

/** Julian day number of a Gregorian date (month 1 to 12). */
function julianDay(day: number, month: number, year: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

const UNIX_EPOCH_JD = 2440588;

function julianToIso(jd: number): string {
  return new Date((jd - UNIX_EPOCH_JD) * 86_400_000).toISOString().slice(0, 10);
}

function newMoon(k: number): number {
  const t = k / 1236.85;
  const t2 = t * t;
  const t3 = t2 * t;
  let jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * t2 - 0.000000155 * t3;
  jd1 += 0.00033 * Math.sin((166.56 + 132.87 * t - 0.009173 * t2) * RAD);
  const m = 359.2242 + 29.10535608 * k - 0.0000333 * t2 - 0.00000347 * t3;
  const mpr = 306.0253 + 385.81691806 * k + 0.0107306 * t2 + 0.00001236 * t3;
  const f = 21.2964 + 390.67050646 * k - 0.0016528 * t2 - 0.00000239 * t3;
  let c1 = (0.1734 - 0.000393 * t) * Math.sin(m * RAD) + 0.0021 * Math.sin(2 * RAD * m);
  c1 += -0.4068 * Math.sin(mpr * RAD) + 0.0161 * Math.sin(RAD * 2 * mpr);
  c1 -= 0.0004 * Math.sin(RAD * 3 * mpr);
  c1 += 0.0104 * Math.sin(RAD * 2 * f) - 0.0051 * Math.sin(RAD * (m + mpr));
  c1 += -0.0074 * Math.sin(RAD * (m - mpr)) + 0.0004 * Math.sin(RAD * (2 * f + m));
  c1 += -0.0004 * Math.sin(RAD * (2 * f - m)) - 0.0006 * Math.sin(RAD * (2 * f + mpr));
  c1 += 0.001 * Math.sin(RAD * (2 * f - mpr)) + 0.0005 * Math.sin(RAD * (2 * mpr + m));
  const deltaT =
    t < -11
      ? 0.001 + 0.000839 * t + 0.0002261 * t2 - 0.00000845 * t3 - 0.000000081 * t * t3
      : -0.000278 + 0.000265 * t + 0.000262 * t2;
  return jd1 + c1 - deltaT;
}

const newMoonDay = (k: number): number => Math.floor(newMoon(k) + 0.5 + VIETNAM_UTC_OFFSET / 24);

/** Sector (0 to 11) of the sun's longitude at local midnight of the given day. */
function sunSector(jdn: number): number {
  const t = (jdn - 2451545.5 - VIETNAM_UTC_OFFSET / 24) / 36525;
  const t2 = t * t;
  const m = 357.5291 + 35999.0503 * t - 0.0001559 * t2 - 0.00000048 * t * t2;
  const l0 = 280.46645 + 36000.76983 * t + 0.0003032 * t2;
  const dl =
    (1.9146 - 0.004817 * t - 0.000014 * t2) * Math.sin(RAD * m) +
    (0.019993 - 0.000101 * t) * Math.sin(RAD * 2 * m) +
    0.00029 * Math.sin(RAD * 3 * m);
  let l = (l0 + dl) * RAD;
  l -= Math.PI * 2 * Math.floor(l / (Math.PI * 2));
  return Math.floor((l / Math.PI) * 6);
}

/** Start day of the lunar month that contains the winter solstice (month 11) of `year`. */
function lunarMonth11(year: number): number {
  const off = julianDay(31, 12, year) - 2415021;
  const k = Math.floor(off / SYNODIC_MONTH);
  let nm = newMoonDay(k);
  if (sunSector(nm) >= 9) nm = newMoonDay(k - 1);
  return nm;
}

/** Offset, from month 11, of the leap month in a 13-month lunar year. */
function leapMonthOffset(a11: number): number {
  const k = Math.floor((a11 - EPOCH_JD) / SYNODIC_MONTH + 0.5);
  let i = 1;
  let arc = sunSector(newMoonDay(k + i));
  let last: number;
  do {
    last = arc;
    i += 1;
    arc = sunSector(newMoonDay(k + i));
  } while (arc !== last && i < 14);
  return i - 1;
}

function parseIso(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`invalid date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function assertSupported(year: number): void {
  if (year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR)
    throw new LunarRangeError(
      `lunar conversion supports years ${LUNAR_MIN_YEAR} to ${LUNAR_MAX_YEAR}, got ${year}`,
    );
}

/** Converts a solar date to the lunar date, flagging a leap month. */
export function solarToLunar(date: string): LunarDate {
  const { year, month, day } = parseIso(date);
  assertSupported(year);
  const dayNumber = julianDay(day, month, year);
  const k = Math.floor((dayNumber - EPOCH_JD) / SYNODIC_MONTH);
  let monthStart = newMoonDay(k + 1);
  if (monthStart > dayNumber) monthStart = newMoonDay(k);
  let a11 = lunarMonth11(year);
  let b11 = a11;
  let lunarYear: number;
  if (a11 >= monthStart) {
    lunarYear = year;
    a11 = lunarMonth11(year - 1);
  } else {
    lunarYear = year + 1;
    b11 = lunarMonth11(year + 1);
  }
  const diff = Math.floor((monthStart - a11) / 29);
  let leap = false;
  let lunarMonthNo = diff + 11;
  if (b11 - a11 > 365) {
    const leapDiff = leapMonthOffset(a11);
    if (diff >= leapDiff) {
      lunarMonthNo = diff + 10;
      if (diff === leapDiff) leap = true;
    }
  }
  if (lunarMonthNo > 12) lunarMonthNo -= 12;
  if (lunarMonthNo >= 11 && diff < 4) lunarYear -= 1;
  return { year: lunarYear, month: lunarMonthNo, day: dayNumber - monthStart + 1, leap };
}

/**
 * Converts a lunar date to the solar date. Day 30 of a 29-day month maps to the last day of that
 * month. Throws `LunarRangeError` outside the supported years or for a leap month that does not
 * exist in that year.
 */
export function lunarToSolar(lunar: LunarDate): string {
  assertSupported(lunar.year);
  let a11: number;
  let b11: number;
  if (lunar.month < 11) {
    a11 = lunarMonth11(lunar.year - 1);
    b11 = lunarMonth11(lunar.year);
  } else {
    a11 = lunarMonth11(lunar.year);
    b11 = lunarMonth11(lunar.year + 1);
  }
  const k = Math.floor(0.5 + (a11 - EPOCH_JD) / SYNODIC_MONTH);
  let off = lunar.month - 11;
  if (off < 0) off += 12;
  if (b11 - a11 > 365) {
    const leapOff = leapMonthOffset(a11);
    let leapMonth = leapOff - 2;
    if (leapMonth < 0) leapMonth += 12;
    if (lunar.leap && lunar.month !== leapMonth)
      throw new LunarRangeError(`no leap month ${lunar.month} in lunar year ${lunar.year}`);
    if (lunar.leap || off >= leapOff) off += 1;
  } else if (lunar.leap) {
    throw new LunarRangeError(`no leap month in lunar year ${lunar.year}`);
  }
  const monthStart = newMoonDay(k + off);
  const nextStart = newMoonDay(k + off + 1);
  const day = Math.min(lunar.day, nextStart - monthStart);
  return julianToIso(monthStart + day - 1);
}
