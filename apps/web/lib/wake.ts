import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type WakeCardState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "recorded"; wakeTime: string; minutesLate: number };

const ResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    wake: z
      .object({
        wakeTime: z.string().nullable(),
        minutesLate: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
  }),
});

/**
 * Reads today's recorded wake (schedule `GET /wake/today`) through same-origin `/api`.
 * Anything but a recorded wake, including errors, means no card is shown.
 */
export async function loadWakeToday(doFetch: FetchLike = fetch): Promise<WakeCardState> {
  try {
    const res = await doFetch("/api/wake/today", { cache: "no-store" });
    if (!res.ok) return { status: "none" };
    const parsed = ResponseSchema.safeParse(await res.json());
    const wake = parsed.success ? parsed.data.data.wake : null;
    if (!wake || wake.wakeTime === null || wake.minutesLate === null) return { status: "none" };
    return { status: "recorded", wakeTime: wake.wakeTime, minutesLate: wake.minutesLate };
  } catch {
    return { status: "none" };
  }
}

/** Formats an instant as HH:mm in the given time zone (the browser zone when omitted). */
export function formatWakeTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
