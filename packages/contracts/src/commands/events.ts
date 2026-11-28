import { z } from "zod";
import { IdSchema } from "../common";
import { CommandChannelSchema, CommandResultStatusSchema } from "./entities";

/** Payloads carry no message text (ADR 0016). */
export const commandEvents = {
  "command.executed": z
    .object({
      commandId: IdSchema,
      channel: CommandChannelSchema,
      status: CommandResultStatusSchema,
      ai: z.boolean(),
    })
    .strict(),
  "command.refused": z
    .object({
      commandId: IdSchema,
      channel: CommandChannelSchema,
      reason: z.enum(["disabled", "invalid_args", "needs_confirmation", "not_allowed"]),
    })
    .strict(),
};
