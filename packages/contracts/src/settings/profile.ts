import { z } from "zod";

/** Appearance and persona setting shapes shared by web and the services (ADR 0021). */

export const SkinSchema = z.enum(["navy", "hanfu", "silver", "street"]);
export type Skin = z.infer<typeof SkinSchema>;

export const ThemeModeSchema = z.enum(["light", "dark", "system"]);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

/** Seven keys shared by all three sets, so switching sets never breaks a mapping. */
export const ExpressionKeySchema = z.enum([
  "greet",
  "joy",
  "love",
  "surprise",
  "ask",
  "sulk",
  "sleep",
]);
export type ExpressionKey = z.infer<typeof ExpressionKeySchema>;

export const ExpressionSetSchema = z.enum(["chibi", "blue_face", "silver_face"]);
export type ExpressionSet = z.infer<typeof ExpressionSetSchema>;

export const ExpressionStateSchema = z.enum([
  "greeting",
  "task_done",
  "praised",
  "news",
  "needs_answer",
  "fault_penalty",
  "bedtime",
]);
export type ExpressionState = z.infer<typeof ExpressionStateSchema>;

/** One expression key per state. */
export const ExpressionMapSchema = z.object({
  greeting: ExpressionKeySchema,
  task_done: ExpressionKeySchema,
  praised: ExpressionKeySchema,
  news: ExpressionKeySchema,
  needs_answer: ExpressionKeySchema,
  fault_penalty: ExpressionKeySchema,
  bedtime: ExpressionKeySchema,
});
export type ExpressionMap = z.infer<typeof ExpressionMapSchema>;

export const DEFAULT_EXPRESSION_MAP: Readonly<ExpressionMap> = {
  greeting: "greet",
  task_done: "joy",
  praised: "love",
  news: "surprise",
  needs_answer: "ask",
  fault_penalty: "sulk",
  bedtime: "sleep",
};

export const PersonaTermSchema = z.object({
  text: z.string().trim().min(1).max(40),
  enabled: z.boolean(),
});
export const PersonaListSchema = z.object({
  vi: z.array(PersonaTermSchema).max(30),
  en: z.array(PersonaTermSchema).max(30),
});
export type PersonaTerm = z.infer<typeof PersonaTermSchema>;
export type PersonaList = z.infer<typeof PersonaListSchema>;
