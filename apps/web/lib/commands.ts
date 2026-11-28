import {
  CommandOverrideSchema,
  CustomCommandInputSchema,
  GetSettingsResponseSchema,
  ListCustomCommandsResponseSchema,
  type CustomCommandInput,
} from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CommandOverride = z.infer<typeof CommandOverrideSchema>;

/** Settings key of the per-user edits of built-ins (spec 02-defaults). */
export const OVERRIDES_KEY = "commands.overrides";
const CUSTOM_URL = "/api/ai/commands/custom";

type BuiltinSpec = readonly [id: string, alias: string];

/**
 * The shipped built-in commands of ADR 0016: the English name equals the id, and every one has
 * one Vietnamese alias. Descriptions live in the locale files under `commands.desc.<id>`.
 */
const SPECS: readonly BuiltinSpec[] = [
  ["help", "tro_giup"],
  ["model", "mo_hinh"],
  ["usage", "su_dung"],
  ["status", "trang_thai"],
  ["new", "moi"],
  ["stop", "dung"],
  ["lang", "ngon_ngu"],
  ["strict", "nghiem"],
  ["quiet", "yen_lang"],
  ["skin", "giao_dien"],
  ["task", "viec"],
  ["spend", "chi"],
  ["remember", "nho"],
  ["forget", "quen"],
  ["summary", "tom_tat"],
  ["today", "hom_nay"],
  ["week", "tuan"],
  ["budget", "ngan_sach"],
  ["happy", "vui"],
  ["sad", "buon"],
  ["tired", "met"],
  ["stressed", "cang_thang"],
  ["angry", "gian"],
  ["appeal", "khang_cao"],
  ["reason", "ly_do"],
];

export const BUILTIN_COMMANDS: ReadonlyArray<{ id: string; alias: string }> = SPECS.map(
  ([id, alias]) => ({ id, alias }),
);

export interface BuiltinRow {
  id: string;
  name: string;
  aliases: string[];
  enabled: boolean;
  /** User text per locale; absent means the shipped description from the locale files. */
  description?: { vi: string; en: string };
}

/** The built-in list with the user's edits applied. */
export function applyOverrides(overrides: readonly CommandOverride[]): BuiltinRow[] {
  return BUILTIN_COMMANDS.map(({ id, alias }) => {
    const o = overrides.find((x) => x.commandId === id);
    return {
      id,
      name: o?.name ?? id,
      aliases: o?.aliases ?? [alias],
      enabled: o?.enabled ?? true,
      ...(o?.description ? { description: o.description } : {}),
    };
  });
}

/** Merges a change into one built-in's override; an entry with no edit left is dropped. */
export function patchOverride(
  overrides: readonly CommandOverride[],
  commandId: string,
  patch: Partial<Omit<CommandOverride, "commandId">>,
): CommandOverride[] {
  const current = overrides.find((o) => o.commandId === commandId);
  const merged: Record<string, unknown> = { ...(current ?? {}), ...patch, commandId };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const rest = overrides.filter((o) => o.commandId !== commandId);
  return Object.keys(merged).length > 1 ? [...rest, merged as CommandOverride] : rest;
}

export type CommandsResult =
  | { status: "ready"; overrides: CommandOverride[]; custom: CustomCommandInput[] }
  | { status: "error" };

/** Reads custom commands from ai and the built-in overrides from the user's settings. */
export async function loadCommands(doFetch: FetchLike = fetch): Promise<CommandsResult> {
  try {
    const [customRes, settingsRes] = await Promise.all([
      doFetch(CUSTOM_URL, { cache: "no-store" }),
      doFetch("/api/settings", { cache: "no-store" }),
    ]);
    if (!customRes.ok || !settingsRes.ok) return { status: "error" };
    const custom = ListCustomCommandsResponseSchema.safeParse(await customRes.json());
    const settings = GetSettingsResponseSchema.safeParse(await settingsRes.json());
    if (!custom.success || !settings.success || !settings.data.ok) return { status: "error" };
    const parsed = z
      .array(CommandOverrideSchema)
      .safeParse(settings.data.data.values[OVERRIDES_KEY]);
    return {
      status: "ready",
      overrides: parsed.success ? parsed.data : [],
      custom: custom.data.data.custom,
    };
  } catch {
    return { status: "error" };
  }
}

export async function saveOverrides(
  overrides: readonly CommandOverride[],
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await doFetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: OVERRIDES_KEY, value: overrides }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type WriteResult = { ok: true } | { ok: false; error: string };

async function send(
  url: string,
  method: "POST" | "DELETE",
  body: unknown,
  doFetch: FetchLike,
): Promise<WriteResult> {
  try {
    const res = await doFetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (res.ok) return { ok: true };
    const parsed = z.object({ error: z.string() }).safeParse(await res.json().catch(() => null));
    return {
      ok: false,
      error: res.status === 422 && parsed.success ? parsed.data.error : "failed",
    };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export const createCustom = (input: CustomCommandInput, doFetch: FetchLike = fetch) =>
  send(CUSTOM_URL, "POST", input, doFetch);

export const deleteCustom = (name: string, doFetch: FetchLike = fetch) =>
  send(`${CUSTOM_URL}/${encodeURIComponent(name)}`, "DELETE", undefined, doFetch);

/**
 * ai has no replace route, so an edit deletes the old command and creates the new one. When
 * the new one is refused the old command is created again, so a refused edit changes nothing.
 */
export async function updateCustom(
  previous: CustomCommandInput,
  next: CustomCommandInput,
  doFetch: FetchLike = fetch,
): Promise<WriteResult> {
  const removed = await deleteCustom(previous.name, doFetch);
  if (!removed.ok) return removed;
  const created = await createCustom(next, doFetch);
  if (created.ok) return created;
  await createCustom(previous, doFetch);
  return created;
}

export interface CustomForm {
  kind: string;
  name: string;
  aliases: string;
  descVi: string;
  descEn: string;
  template?: string;
  expressionKey?: string;
  targetCommandId?: string;
  presetArgs?: string;
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^\//, ""))
    .filter((s) => s !== "");

/** Turns the form fields into a validated custom command; the contract schema decides validity. */
export function formToCustomInput(
  form: CustomForm,
  enabled = true,
): { ok: true; input: CustomCommandInput } | { ok: false } {
  const base = {
    name: form.name.trim().replace(/^\//, ""),
    aliases: list(form.aliases),
    description: { vi: form.descVi.trim(), en: form.descEn.trim() },
    enabled,
    kind: form.kind,
  };
  const raw =
    form.kind === "prompt"
      ? { ...base, template: form.template ?? "" }
      : form.kind === "mood"
        ? { ...base, expressionKey: (form.expressionKey ?? "").trim() }
        : {
            ...base,
            targetCommandId: (form.targetCommandId ?? "").trim(),
            presetArgs: list(form.presetArgs),
          };
  const parsed = CustomCommandInputSchema.safeParse(raw);
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false };
}
