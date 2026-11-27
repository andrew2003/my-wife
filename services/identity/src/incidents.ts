import type { IncidentSchema } from "@my-wife/contracts";

export type Incident = ReturnType<typeof IncidentSchema.parse>;

/** One admin action: who, what, before and after, when. Holds no personal content. */
export type AuditEntry = {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: string;
};

/** Incidents and their audit trail; in memory until the Drizzle store lands. */
export interface IncidentStore {
  save(incident: Incident, audit: AuditEntry): Promise<void>;
  find(id: string): Promise<Incident | undefined>;
  list(): Promise<Incident[]>;
  /** Appends an audit entry that belongs to no incident (invitations, sender map). */
  addAudit(entry: AuditEntry): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
}

export function createIncidentStore(): IncidentStore {
  const incidents = new Map<string, Incident>();
  const audit: AuditEntry[] = [];
  return {
    async save(incident, entry) {
      incidents.set(incident.id, { ...incident });
      audit.push(entry);
    },
    async find(id) {
      const i = incidents.get(id);
      return i && { ...i };
    },
    async list() {
      return [...incidents.values()].map((i) => ({ ...i }));
    },
    async addAudit(entry) {
      audit.push(entry);
    },
    async listAudit() {
      return [...audit];
    },
  };
}

/** Whether a user is in the incident's scope. */
export function incidentCoversUser(incident: Incident, userId: string): boolean {
  return incident.scope === "all" || incident.scope.includes(userId);
}
