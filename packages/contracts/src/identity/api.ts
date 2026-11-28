import { z } from "zod";
import {
  ConsentKindSchema,
  IdSchema,
  IsoDateTimeSchema,
  okOrError,
} from "../common";
import { SaveLlmKeyRequestSchema } from "../ai/api";
import { SettingKeySchema } from "../settings/registry";
import { RuleChangeDirectionSchema } from "../rules/enums";
import {
  AuditLogEntrySchema,
  ConsentRecordSchema,
  IncidentSchema,
  InvitationSchema,
  LlmKeyViewSchema,
  UserFeatureFlagSchema,
  UserSchema,
} from "./entities";
import { FeatureFlagSchema, OnboardingStepSchema } from "./enums";

export const AcceptInvitationRequestSchema = z.object({ token: z.string().min(1) });
export const AcceptInvitationResponseSchema = okOrError(z.object({ user: UserSchema }));

export const SessionResponseSchema = okOrError(
  z.object({ user: UserSchema, expiresAt: IsoDateTimeSchema }),
);

export const GetSettingsResponseSchema = okOrError(
  z.object({ values: z.record(SettingKeySchema, z.unknown()) }),
);
export const UpdateSettingRequestSchema = z.object({ key: SettingKeySchema, value: z.unknown() });
export const UpdateSettingResponseSchema = okOrError(
  z.object({
    key: SettingKeySchema,
    direction: RuleChangeDirectionSchema,
    /** Tightening is effective now; loosening is locked until this instant. */
    effectiveFrom: IsoDateTimeSchema,
  }),
);

export const ConsentRequestSchema = z.object({
  kind: ConsentKindSchema,
  textVersion: z.number().int().positive(),
});
export const ConsentListResponseSchema = okOrError(z.object({ consents: z.array(ConsentRecordSchema) }));

export const SaveKeyRequestSchema = SaveLlmKeyRequestSchema;
export const SaveKeyResponseSchema = okOrError(z.object({ key: LlmKeyViewSchema }));
export const ListKeysResponseSchema = okOrError(
  z.object({ keys: z.array(LlmKeyViewSchema), nextCursor: z.string().min(1).nullable().default(null) }),
);

export const CompleteOnboardingStepRequestSchema = z.object({
  step: OnboardingStepSchema,
  skipped: z.boolean().default(false),
});
export const RequestDeletionResponseSchema = okOrError(
  z.object({ state: z.enum(["closing", "closed"]), exportOffered: z.boolean() }),
);
export const ExportResponseSchema = okOrError(
  z.object({ downloadUrl: z.string().url(), expiresAt: IsoDateTimeSchema }),
);

/** Admin API: gateway returns 403 for a non-admin session. */
export const CreateInvitationRequestSchema = z.object({ email: z.string().email() });
export const CreateInvitationResponseSchema = okOrError(z.object({ invitation: InvitationSchema }));
export const DeclareIncidentRequestSchema = IncidentSchema.pick({
  startsAt: true,
  endsAt: true,
  scope: true,
  reason: true,
});
export const DeclareIncidentResponseSchema = okOrError(z.object({ incident: IncidentSchema }));
export const SetFeatureFlagRequestSchema = z.object({
  userId: IdSchema,
  flag: FeatureFlagSchema,
  enabled: z.boolean(),
});
export const SetFeatureFlagResponseSchema = okOrError(z.object({ flag: UserFeatureFlagSchema }));
export const SenderMapEntryRequestSchema = z.object({
  senderKey: z.string().min(1),
  senderAddress: z.string().min(1),
  dkimDomain: z.string().min(1),
});
export const AuditQueryResponseSchema = okOrError(z.object({ entries: z.array(AuditLogEntrySchema) }));
