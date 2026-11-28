import type { CommandDefinition } from "@my-wife/contracts";

/** Shipped defaults of ADR 0016: an English name and a Vietnamese alias per command. */
type BuiltinSpec = readonly [id: string, alias: string, ai: boolean, args?: readonly string[]];

const SPECS: readonly BuiltinSpec[] = [
  // Control.
  ["help", "tro_giup", false],
  ["model", "mo_hinh", false, ["name"]],
  ["usage", "su_dung", false],
  ["status", "trang_thai", false],
  ["new", "moi", false],
  ["stop", "dung", false],
  ["lang", "ngon_ngu", false, ["language"]],
  ["strict", "nghiem", false, ["level"]],
  ["quiet", "yen_lang", false, ["until"]],
  ["skin", "giao_dien", false, ["name"]],
  // Capture.
  ["task", "viec", false, ["text"]],
  ["spend", "chi", false, ["amount"]],
  ["remember", "nho", false, ["text"]],
  ["forget", "quen", false, ["text"]],
  // Summaries: the model writes them from facts supplied by code.
  ["summary", "tom_tat", true],
  ["today", "hom_nay", true],
  ["week", "tuan", true],
  ["budget", "ngan_sach", true],
  // Mood tags.
  ["happy", "vui", true, ["text"]],
  ["sad", "buon", true, ["text"]],
  ["tired", "met", true, ["text"]],
  ["stressed", "cang_thang", true, ["text"]],
  ["angry", "gian", true, ["text"]],
  // Rules.
  ["appeal", "khang_cao", false, ["fault"]],
  ["reason", "ly_do", false, ["text"]],
];

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = SPECS.map(
  ([id, alias, ai, args = []]) => ({
    id,
    kind: "builtin",
    name: id,
    aliases: [alias],
    descriptionKey: `commands.desc.${id}`,
    enabled: true,
    ai,
    builtin: true,
    args: args.map((name) => ({ name, required: false })),
  }),
);
