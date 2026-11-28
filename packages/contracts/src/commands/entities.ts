import { z } from "zod";
import { ChannelKindSchema, IdSchema, LocaleSchema, MessageRefSchema } from "../common";

/** Command names and aliases, unique per user across both (ADR 0016). */
export const COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
export const CommandNameSchema = z.string().regex(COMMAND_NAME_PATTERN);

/** Channels a command can arrive from: the chat adapters and the in-app chat. */
export const CommandChannelSchema = z.union([ChannelKindSchema, z.literal("web")]);
export type CommandChannel = z.infer<typeof CommandChannelSchema>;

export const CommandKindSchema = z.enum(["builtin", "prompt", "mood", "shortcut"]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const CustomCommandKindSchema = z.enum(["prompt", "mood", "shortcut"]);

export const MoodTagSchema = z.enum(["happy", "sad", "tired", "stressed", "angry"]);
export type MoodTag = z.infer<typeof MoodTagSchema>;

export const CommandResultStatusSchema = z.enum(["ok", "refused", "needs_confirmation", "unknown", "disabled"]);
export type CommandResultStatus = z.infer<typeof CommandResultStatusSchema>;

/** Editable text per locale; one or two sentences. */
export const CommandDescriptionSchema = z.object({
  vi: z.string().min(1).max(500),
  en: z.string().min(1).max(500),
});

export const CommandArgSpecSchema = z.object({
  name: z.string().min(1),
  required: z.boolean().default(false),
  hint: z.string().optional(),
});

const distinctNames = (v: { name: string; aliases: string[] }) =>
  new Set([v.name, ...v.aliases]).size === v.aliases.length + 1;
const DISTINCT_MESSAGE = "name and aliases must be distinct";

export const CommandDefinitionSchema = z
  .object({
    id: IdSchema,
    kind: CommandKindSchema,
    name: CommandNameSchema,
    aliases: z.array(CommandNameSchema).max(10).default([]),
    /** Locale-file key for built-ins that ship default descriptions. */
    descriptionKey: z.string().min(1).optional(),
    /** User text; overrides the key when present. */
    description: CommandDescriptionSchema.optional(),
    enabled: z.boolean(),
    /** Only AI commands pass text to the model. */
    ai: z.boolean(),
    builtin: z.boolean(),
    args: z.array(CommandArgSpecSchema).default([]),
  })
  .refine((v) => v.descriptionKey !== undefined || v.description !== undefined, {
    message: "a description key or description text is required",
    path: ["description"],
  })
  .refine(distinctNames, { message: DISTINCT_MESSAGE, path: ["aliases"] });
export type CommandDefinition = z.infer<typeof CommandDefinitionSchema>;

const customBase = {
  name: CommandNameSchema,
  aliases: z.array(CommandNameSchema).max(10).default([]),
  description: CommandDescriptionSchema,
  enabled: z.boolean().default(true),
};

/** Input for creating or replacing a custom command. A custom command reaches only what built-ins reach. */
export const CustomCommandInputSchema = z
  .discriminatedUnion("kind", [
    z.object({
      ...customBase,
      kind: z.literal("prompt"),
      template: z.string().min(1).max(2000).refine((t) => t.includes("{text}"), "template must contain {text}"),
    }),
    z.object({ ...customBase, kind: z.literal("mood"), expressionKey: z.string().min(1).max(64) }),
    z.object({
      ...customBase,
      kind: z.literal("shortcut"),
      targetCommandId: IdSchema,
      presetArgs: z.array(z.string()).default([]),
    }),
  ])
  .superRefine((v, ctx) => {
    if (!distinctNames(v)) ctx.addIssue({ code: "custom", message: DISTINCT_MESSAGE, path: ["aliases"] });
  });
export type CustomCommandInput = z.infer<typeof CustomCommandInputSchema>;

/** A parsed inbound command. `rawText` is untrusted and never copied into events. */
export const CommandInvocationSchema = z.object({
  channel: CommandChannelSchema,
  userId: IdSchema,
  rawText: z.string().startsWith("/").max(4000),
  resolvedCommandId: IdSchema.optional(),
  args: z.array(z.string()),
  locale: LocaleSchema,
});
export type CommandInvocation = z.infer<typeof CommandInvocationSchema>;

export const CommandResultSchema = z.object({
  status: CommandResultStatusSchema,
  reply: MessageRefSchema,
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

/** Per-user edits of built-ins. Absent fields keep the shipped default. */
export const CommandOverrideSchema = z
  .object({
    commandId: IdSchema,
    enabled: z.boolean().optional(),
    name: CommandNameSchema.optional(),
    aliases: z.array(CommandNameSchema).max(10).optional(),
    description: CommandDescriptionSchema.optional(),
  })
  .refine((v) => v.name === undefined || v.aliases === undefined || distinctNames({ name: v.name, aliases: v.aliases }), {
    message: DISTINCT_MESSAGE,
    path: ["aliases"],
  });

export const CommandSettingsSchema = z.object({
  overrides: z.array(CommandOverrideSchema),
  custom: z.array(CustomCommandInputSchema),
});
export type CommandSettings = z.infer<typeof CommandSettingsSchema>;

/** One entry of the menu registered with Telegram and Discord (description max 256 chars). */
export const CommandMenuEntrySchema = z.object({
  command: CommandNameSchema,
  description: z.string().min(1).max(256),
});
export type CommandMenuEntry = z.infer<typeof CommandMenuEntrySchema>;

/** `GET /commands/custom` response of the ai service. */
export const ListCustomCommandsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ custom: z.array(CustomCommandInputSchema) }),
});
