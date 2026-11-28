import { ListFaultsResponseSchema, OpenAppealRequestSchema } from "@my-wife/contracts";
import { getJson, InternalCallError } from "./http";

/** Rules routes behind `/appeal` and `/reason`: the fault list and the open-appeal write. */
export const FAULTS_PATH = "/faults";
export const APPEALS_PATH = "/appeals";

export interface FaultSummary {
  id: string;
  type: string;
  status: string;
  points: number;
  occurredAt: string;
  systemCause: string | null;
}

export type AppealOutcome = { ok: true } | { ok: false; error: string };

export interface RulesClient {
  /** Newest first. */
  latestFaults(userId: string, limit: number): Promise<FaultSummary[]>;
  /** Rules decides everything; a 409 comes back as `{ ok: false, error }`. */
  openAppeal(
    userId: string,
    input: { subjectId: string; reasonText: string },
  ): Promise<AppealOutcome>;
}

export function createRulesClient(baseUrl: string, fetchFn: typeof fetch = fetch): RulesClient {
  return {
    async latestFaults(userId, limit) {
      const data = await getJson(
        fetchFn,
        "rules",
        `${baseUrl}${FAULTS_PATH}?limit=${limit}`,
        userId,
      );
      const parsed = ListFaultsResponseSchema.parse({ ok: true, data });
      if (!parsed.ok) throw new InternalCallError("rules", 200);
      return parsed.data.faults.map((f) => ({
        id: f.id,
        type: f.type,
        status: f.status,
        points: f.points,
        occurredAt: f.occurredAt,
        systemCause: f.systemCause,
      }));
    },
    async openAppeal(userId, input) {
      const body = OpenAppealRequestSchema.parse({ subjectKind: "fault", ...input });
      const res = await fetchFn(`${baseUrl}${APPEALS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": userId },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true };
      if (res.status === 409) {
        const parsed = (await res.json().catch(() => null)) as {
          error?: { code?: unknown };
        } | null;
        const code = parsed?.error?.code;
        return { ok: false, error: typeof code === "string" ? code : "rules.refused" };
      }
      throw new InternalCallError("rules", res.status);
    },
  };
}
