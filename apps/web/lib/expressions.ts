import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Seven keys shared by all three sets, so switching sets never breaks a mapping. */
export const EXPRESSION_KEYS = [
  "greet",
  "joy",
  "love",
  "surprise",
  "ask",
  "sulk",
  "sleep",
] as const;
export type ExpressionKey = (typeof EXPRESSION_KEYS)[number];

/** Chibi is the default for the whole system and every skin. */
export const EXPRESSION_SETS = ["chibi", "blue_face", "silver_face"] as const;
export type ExpressionSet = (typeof EXPRESSION_SETS)[number];
export const DEFAULT_EXPRESSION_SET: ExpressionSet = "chibi";

export const EXPRESSION_STATES = [
  "greeting",
  "task_done",
  "praised",
  "news",
  "needs_answer",
  "fault_penalty",
  "bedtime",
] as const;
export type ExpressionState = (typeof EXPRESSION_STATES)[number];

export type ExpressionMap = Record<ExpressionState, ExpressionKey>;

/** Defaults from the approved board; the user changes any of them in settings. */
export const DEFAULT_EXPRESSION_MAP: Readonly<ExpressionMap> = {
  greeting: "greet",
  task_done: "joy",
  praised: "love",
  news: "surprise",
  needs_answer: "ask",
  fault_penalty: "sulk",
  bedtime: "sleep",
};

/** Settings keys from spec 02-defaults. */
export const EXPRESSION_SETTING_KEYS = {
  set: "appearance.expression_set",
  map: "appearance.expression_map",
} as const;

export interface ExpressionSettings {
  set: ExpressionSet;
  map: ExpressionMap;
}

// Local shape until the appearance keys move into packages/contracts (follow-up ADR).
const SettingsEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ values: z.record(z.string(), z.unknown()) }),
});

export function defaultExpressionSettings(): ExpressionSettings {
  return { set: DEFAULT_EXPRESSION_SET, map: { ...DEFAULT_EXPRESSION_MAP } };
}

const isSet = (v: unknown): v is ExpressionSet =>
  typeof v === "string" && (EXPRESSION_SETS as readonly string[]).includes(v);
const isKey = (v: unknown): v is ExpressionKey =>
  typeof v === "string" && (EXPRESSION_KEYS as readonly string[]).includes(v);

/** Art file key for one set and expression key, for example `blue-face-joy`. */
export function expressionArtKey(set: ExpressionSet, key: ExpressionKey): string {
  return `${set.replace(/_/g, "-")}-${key}`;
}

/** The art key to show for a state; an unknown stored key falls back to the default. */
export function resolveExpression(settings: ExpressionSettings, state: ExpressionState): string {
  const stored: unknown = settings.map[state];
  const key = isKey(stored) ? stored : DEFAULT_EXPRESSION_MAP[state];
  const set = isSet(settings.set) ? settings.set : DEFAULT_EXPRESSION_SET;
  return expressionArtKey(set, key);
}

/** Changes the set only; keys are shared, so the per-state mapping is kept as it is. */
export function switchSet(settings: ExpressionSettings, set: ExpressionSet): ExpressionSettings {
  return { set, map: { ...settings.map } };
}

export type ExpressionsResult =
  { status: "ready"; settings: ExpressionSettings } | { status: "error" };

/** Reads the set and mapping; any missing or unknown value falls back to its default. */
export async function loadExpressions(doFetch: FetchLike = fetch): Promise<ExpressionsResult> {
  try {
    const res = await doFetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = SettingsEnvelopeSchema.safeParse(await res.json());
    if (!parsed.success) return { status: "error" };
    const values = parsed.data.data.values;
    const settings = defaultExpressionSettings();
    const set = values[EXPRESSION_SETTING_KEYS.set];
    if (isSet(set)) settings.set = set;
    const stored = z.record(z.string(), z.unknown()).safeParse(values[EXPRESSION_SETTING_KEYS.map]);
    if (stored.success) {
      for (const state of EXPRESSION_STATES) {
        const key = stored.data[state];
        if (isKey(key)) settings.map[state] = key;
      }
    }
    return { status: "ready", settings };
  } catch {
    return { status: "error" };
  }
}

/** Saves the set and the mapping; true only when both writes succeeded. */
export async function saveExpressions(
  settings: ExpressionSettings,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  try {
    const writes: Array<[string, unknown]> = [
      [EXPRESSION_SETTING_KEYS.set, settings.set],
      [EXPRESSION_SETTING_KEYS.map, settings.map],
    ];
    for (const [key, value] of writes) {
      const res = await doFetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}
