/** Calendar day (`YYYY-MM-DD`) of `at` in the given IANA time zone; falls back to UTC. */
export function dayKeyOf(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Rough token estimate (about 4 characters per token) for providers that report no usage. */
export function estimateTokens(...texts: string[]): number {
  return Math.ceil(texts.reduce((sum, t) => sum + t.length, 0) / 4);
}

/** Tokens spent per user and day, plus which days already announced the cap. In memory for now. */
export class TokenUsageStore {
  private readonly used = new Map<string, number>();
  private readonly announced = new Set<string>();

  private key(userId: string, day: string): string {
    return `${userId}|${day}`;
  }

  usedOn(userId: string, day: string): number {
    return this.used.get(this.key(userId, day)) ?? 0;
  }

  add(userId: string, day: string, tokens: number): void {
    const k = this.key(userId, day);
    this.used.set(k, (this.used.get(k) ?? 0) + Math.max(0, Math.floor(tokens)));
  }

  /** True the first time it is called for a user and day; the event goes out once a day. */
  markAnnounced(userId: string, day: string): boolean {
    const k = this.key(userId, day);
    if (this.announced.has(k)) return false;
    this.announced.add(k);
    return true;
  }
}
