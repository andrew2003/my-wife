import { z } from "zod";
import {
  DEFAULT_MODE,
  DEFAULT_SKIN,
  MODE_COOKIE,
  SKIN_COOKIE,
  parseMode,
  parseSkin,
  type Mode,
  type Skin,
} from "./theme";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Appearance {
  skin: Skin;
  mode: Mode;
}

/** Settings keys from spec 02-defaults; the profile mirror of the two cookies. */
export const APPEARANCE_KEYS = { skin: "appearance.skin", mode: "appearance.mode" } as const;

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const SettingsEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ values: z.record(z.string(), z.unknown()) }),
});

/** Cookie strings the client control writes (not HttpOnly; the server reads them per request). */
export function appearanceCookies(value: Appearance, secure: boolean): [string, string] {
  const tail = `; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax${secure ? "; secure" : ""}`;
  return [`${SKIN_COOKIE}=${value.skin}${tail}`, `${MODE_COOKIE}=${value.mode}${tail}`];
}

export type AppearanceResult = { status: "ready"; appearance: Appearance } | { status: "error" };

/** Reads the profile copy; unknown values fall back to the defaults. */
export async function loadAppearance(doFetch: FetchLike = fetch): Promise<AppearanceResult> {
  try {
    const res = await doFetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = SettingsEnvelopeSchema.safeParse(await res.json());
    if (!parsed.success) return { status: "error" };
    const values = parsed.data.data.values;
    const skin = values[APPEARANCE_KEYS.skin];
    const mode = values[APPEARANCE_KEYS.mode];
    return {
      status: "ready",
      appearance: {
        skin: typeof skin === "string" ? parseSkin(skin) : DEFAULT_SKIN,
        mode: typeof mode === "string" ? parseMode(mode) : DEFAULT_MODE,
      },
    };
  } catch {
    return { status: "error" };
  }
}

/** Mirrors skin and mode to the profile; true only when both writes succeeded. */
export async function saveAppearance(
  value: Appearance,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  try {
    for (const name of ["skin", "mode"] as const) {
      const res = await doFetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: APPEARANCE_KEYS[name], value: value[name] }),
      });
      if (!res.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}
