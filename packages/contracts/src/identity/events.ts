import { z } from "zod";
import { ConsentKindSchema, IdSchema, IsoDateSchema, IsoDateTimeSchema } from "../common";
import { ModelRoleSchema } from "../ai/enums";
import { FeatureFlagSchema, OnboardingStepSchema } from "./enums";

export const identityEvents = {
  "user.invited": z.object({ invitationId: IdSchema, expiresAt: IsoDateTimeSchema }),
  "user.activated": z.object({}),
  /** Carries only key names; consumers re-read values through the settings API. */
  "user.updated": z.object({ changedKeys: z.array(z.string().min(1)).min(1) }),
  "user.suspended": z.object({}),
  "user.closing": z.object({ reason: z.literal("deletion_requested") }),
  "user.closed": z.object({}),
  "consent.granted": z.object({ kind: ConsentKindSchema, textVersion: z.number().int().positive() }),
  "consent.revoked": z.object({ kind: ConsentKindSchema }),
  "llm_key.saved": z.object({ role: ModelRoleSchema, keyId: z.string() }),
  "llm_key.invalid": z.object({ role: ModelRoleSchema, keyId: z.string() }),
  "onboarding.step_completed": z.object({ step: OnboardingStepSchema, skipped: z.boolean() }),
  "export.ready": z.object({ expiresAt: IsoDateTimeSchema }),
};

/** Admin actions; published by identity (the admin API owner). */
export const adminEvents = {
  "incident.declared": z.object({
    incidentId: IdSchema,
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema.nullable(),
    scope: z.union([z.literal("all"), z.array(z.string())]),
  }),
  "incident.ended": z.object({ incidentId: IdSchema, endsAt: IsoDateTimeSchema }),
  "incident.cancelled": z.object({ incidentId: IdSchema }),
  "feature_flag.changed": z.object({ flag: FeatureFlagSchema, enabled: z.boolean() }),
  "invitation.created": z.object({ invitationId: IdSchema }),
  "invitation.revoked": z.object({ invitationId: IdSchema }),
  "sender_map.changed": z.object({ senderKey: z.string().min(1), removed: z.boolean(), on: IsoDateSchema }),
};
