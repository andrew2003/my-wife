import { z } from "zod";
import { translate, type Locale } from "./i18n";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const PersonaTermSchema = z.object({ text: z.string().trim().min(1), enabled: z.boolean() });
export const PersonaListSchema = z.object({
  vi: z.array(PersonaTermSchema),
  en: z.array(PersonaTermSchema),
});

// Local shape until the persona keys move into packages/contracts (follow-up ADR); the shared
// settings schema only accepts registered keys.
const SettingsEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ values: z.record(z.string(), z.unknown()) }),
});

export type PersonaTerm = z.infer<typeof PersonaTermSchema>;
export type PersonaList = z.infer<typeof PersonaListSchema>;
export type PersonaField = "address_user" | "self_reference" | "wife_label";
export type PersonaSettings = Record<PersonaField, PersonaList>;

/** The three lists, their settings keys (spec 02-defaults) and the placeholder each one fills. */
export const PERSONA_KEYS: ReadonlyArray<{
  field: PersonaField;
  key: `persona.${PersonaField}`;
  placeholder: "addressUser" | "self" | "wifeLabel";
}> = [
  { field: "address_user", key: "persona.address_user", placeholder: "addressUser" },
  { field: "self_reference", key: "persona.self_reference", placeholder: "self" },
  { field: "wife_label", key: "persona.wife_label", placeholder: "wifeLabel" },
];

export interface ResolvedTerms {
  addressUser: string;
  self: string;
  wifeLabel: string;
}

function split(value: string): string[] {
  return value
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function defaultsFor(locale: Locale, field: PersonaField): PersonaTerm[] {
  const on = split(translate(locale, `persona.default.${field}`));
  const off = split(translate(locale, `persona.offered.${field}`));
  return [
    ...on.map((text) => ({ text, enabled: true })),
    ...off.map((text) => ({ text, enabled: false })),
  ];
}

/** Defaults live in the locale files; the user can edit, switch off or remove every one. */
export function defaultPersonaSettings(): PersonaSettings {
  const out = {} as PersonaSettings;
  for (const { field } of PERSONA_KEYS) {
    out[field] = { vi: defaultsFor("vi", field), en: defaultsFor("en", field) };
  }
  return out;
}

/**
 * Picks the terms for one text. `index` rotates through the enabled terms so replies vary;
 * a list with nothing enabled uses the neutral word from the locale file, never a removed term.
 */
export function resolveTerms(settings: PersonaSettings, locale: Locale, index = 0): ResolvedTerms {
  const pick = (field: PersonaField): string => {
    const enabled = settings[field][locale].filter((t) => t.enabled);
    if (enabled.length === 0) return translate(locale, `persona.neutral.${field}`);
    return enabled[((index % enabled.length) + enabled.length) % enabled.length]!.text;
  };
  return {
    addressUser: pick("address_user"),
    self: pick("self_reference"),
    wifeLabel: pick("wife_label"),
  };
}

/** `translate` plus the persona placeholders `{addressUser}`, `{self}` and `{wifeLabel}`. */
export function tp(
  locale: Locale,
  key: string,
  terms: ResolvedTerms,
  params: Record<string, string | number> = {},
): string {
  return translate(locale, key, { ...terms, ...params });
}

export type PersonaResult = { status: "ready"; settings: PersonaSettings } | { status: "error" };

/** Reads the three lists; a missing or malformed list falls back to the locale defaults. */
export async function loadPersona(doFetch: FetchLike = fetch): Promise<PersonaResult> {
  try {
    const res = await doFetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = SettingsEnvelopeSchema.safeParse(await res.json());
    if (!parsed.success) return { status: "error" };
    const values = parsed.data.data.values;
    const settings = defaultPersonaSettings();
    for (const { field, key } of PERSONA_KEYS) {
      const list = PersonaListSchema.safeParse(values[key]);
      if (list.success) settings[field] = list.data;
    }
    return { status: "ready", settings };
  } catch {
    return { status: "error" };
  }
}

/** Saves each list under its settings key; true only when every write succeeded. */
export async function savePersona(
  settings: PersonaSettings,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  try {
    for (const { field, key } of PERSONA_KEYS) {
      const res = await doFetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value: settings[field] }),
      });
      if (!res.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}
