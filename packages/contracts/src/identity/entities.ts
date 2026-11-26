import { z } from "zod";
import {
  ConsentKindSchema,
  IdSchema,
  IsoDateTimeSchema,
  LocaleSchema,
} from "../common";
import { ModelRoleSchema, LlmProviderSchema } from "../ai/enums";
import {
  AccountStateSchema,
  FeatureFlagSchema,
  IncidentStateSchema,
  RoleSchema,
} from "./enums";

export const UserSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  state: AccountStateSchema,
  role: RoleSchema,
  locale: LocaleSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
});

export const ConsentRecordSchema = z.object({
  kind: ConsentKindSchema,
  textVersion: z.number().int().positive(),
  grantedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
});

/** What any API returns about a stored key. There is deliberately no secret field. */
export const LlmKeyViewSchema = z
  .object({
    provider: LlmProviderSchema,
    model: z.string().min(1),
    keyId: z.string().min(1),
    valid: z.boolean(),
    role: ModelRoleSchema,
  })
  .strict();
export type LlmKeyView = z.infer<typeof LlmKeyViewSchema>;

export const InvitationSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  expiresAt: IsoDateTimeSchema,
  usedAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
});

export const IncidentSchema = z.object({
  id: IdSchema,
  state: IncidentStateSchema,
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema.nullable(),
  scope: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
  reason: z.string().min(1),
});

export const UserFeatureFlagSchema = z.object({
  userId: IdSchema,
  flag: FeatureFlagSchema,
  enabled: z.boolean(),
});

export const AuditLogEntrySchema = z.object({
  id: IdSchema,
  actorId: IdSchema,
  action: z.string().min(1),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  at: IsoDateTimeSchema,
});
