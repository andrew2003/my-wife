/** Gmail forwarding confirmation: recognized by sender and subject, no LLM (spec 11, section 1). */

export type ForwardingSender = { senderAddress: string; dkimDomain: string };

/** The default Gmail sender. Deployments can override the list through `PipelineDeps`. */
export const GMAIL_FORWARDING_SENDERS: ForwardingSender[] = [
  { senderAddress: "forwarding-noreply@google.com", dkimDomain: "google.com" },
];

const SUBJECT_FINGERPRINT = /^\s*(?:(?:re|fwd?):\s*)*gmail forwarding confirmation\b/i;
const CODE = /confirmation code:\s*(\d{4,12})\b/i;
const URL_CANDIDATE = /https:\/\/[^\s<>"')\]]+/gi;

export type PendingConfirmation = {
  code: string;
  /** Only an https link on the sender's own signing domain; otherwise null. */
  link: string | null;
  expiresAt: string;
};

export interface ForwardingStore {
  /** Keeps one pending confirmation per user: a newer mail replaces the older one. */
  savePending(userId: string, pending: PendingConfirmation): Promise<void>;
  /** The pending confirmation that has not expired at `now`, if any. */
  findPending(userId: string, now: Date): Promise<PendingConfirmation | null>;
}

export class MemoryForwardingStore implements ForwardingStore {
  private readonly byUser = new Map<string, PendingConfirmation>();

  async savePending(userId: string, pending: PendingConfirmation) {
    this.byUser.set(userId, { ...pending });
  }

  async findPending(userId: string, now: Date) {
    const found = this.byUser.get(userId);
    return found && Date.parse(found.expiresAt) >= now.getTime() ? { ...found } : null;
  }
}

export const isForwardingSubject = (subject: string) => SUBJECT_FINGERPRINT.test(subject);

/** The code exactly as written in the mail (verbatim by construction), or null. */
export function extractCode(body: string): string | null {
  return CODE.exec(body)?.[1] ?? null;
}

/** The first https link whose host is the signing domain or one of its subdomains. */
export function extractLink(body: string, dkimDomain: string): string | null {
  const domain = dkimDomain.toLowerCase();
  for (const candidate of body.match(URL_CANDIDATE) ?? []) {
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (host === domain || host.endsWith(`.${domain}`)) return candidate;
    } catch {
      // not a URL; ignore
    }
  }
  return null;
}
