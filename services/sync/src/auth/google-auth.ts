import { randomBytes } from "node:crypto";
import { decryptToken, encryptToken } from "./token-crypto";

export type SyncTarget = "sheets" | "calendar";
export type SyncLinkState = "unlinked" | "linking" | "ready" | "syncing" | "error" | "revoked";

/** Narrow scope: only files the app created or the user opened with it. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const SCOPES: Record<SyncTarget, string[]> = {
  sheets: [DRIVE_FILE_SCOPE],
  calendar: [CALENDAR_EVENTS_SCOPE],
};

/** Port to Google; the real HTTP client implements it, tests use a fake. */
export interface GoogleOAuthClient {
  buildAuthorizationUrl(p: { scopes: string[]; state: string }): string;
  exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string }>;
  /** A cheap write that proves the granted access works. */
  testWrite(target: SyncTarget, accessToken: string): Promise<void>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string }>;
  revoke(refreshToken: string): Promise<void>;
}

export type LinkRecord = {
  userId: string;
  target: SyncTarget;
  state: SyncLinkState;
  pendingState: string | null;
  /** Encrypted at rest; never leaves the service. */
  refreshTokenEnc: string | null;
  lastSyncedAt: string | null;
  maskTitles: boolean;
};

export interface LinkStore {
  get(userId: string, target: SyncTarget): Promise<LinkRecord | undefined>;
  put(record: LinkRecord): Promise<void>;
  list(userId: string): Promise<LinkRecord[]>;
}

export class InMemoryLinkStore implements LinkStore {
  private rows = new Map<string, LinkRecord>();
  async get(userId: string, target: SyncTarget) {
    return this.rows.get(`${userId}:${target}`);
  }
  async put(record: LinkRecord) {
    this.rows.set(`${record.userId}:${record.target}`, { ...record });
  }
  async list(userId: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId);
  }
  /** Test helper: the raw stored rows. */
  dump(): LinkRecord[] {
    return [...this.rows.values()];
  }
}

export class SyncAuthError extends Error {
  constructor(public readonly code: "consent_required" | "invalid_state" | "link_failed") {
    super(code);
  }
}

/** Public view of a link: no token material. */
export type LinkStatus = {
  target: SyncTarget;
  state: SyncLinkState;
  lastSyncedAt: string | null;
  maskTitles: boolean;
};

const toStatus = (r: LinkRecord): LinkStatus => ({
  target: r.target,
  state: r.state,
  lastSyncedAt: r.lastSyncedAt,
  maskTitles: r.maskTitles,
});

export type GoogleAuthDeps = {
  google: GoogleOAuthClient;
  store: LinkStore;
  encryptionKey: string;
  /** True while the user's `google_sync` consent is granted. */
  hasConsent(userId: string): Promise<boolean>;
};

export class GoogleAuthService {
  constructor(private readonly deps: GoogleAuthDeps) {}

  async start(
    userId: string,
    target: SyncTarget,
    _now: Date,
  ): Promise<{ authorizationUrl: string; state: string }> {
    if (!(await this.deps.hasConsent(userId))) throw new SyncAuthError("consent_required");
    const state = randomBytes(24).toString("base64url");
    const prev = await this.deps.store.get(userId, target);
    await this.deps.store.put({
      userId,
      target,
      state: "linking",
      pendingState: state,
      refreshTokenEnc: null,
      lastSyncedAt: prev?.lastSyncedAt ?? null,
      maskTitles: prev?.maskTitles ?? false,
    });
    const authorizationUrl = this.deps.google.buildAuthorizationUrl({
      scopes: SCOPES[target],
      state,
    });
    return { authorizationUrl, state };
  }

  async complete(
    userId: string,
    target: SyncTarget,
    code: string,
    state: string,
    _now: Date,
  ): Promise<LinkStatus> {
    const link = await this.deps.store.get(userId, target);
    if (!link || link.state !== "linking" || !link.pendingState || link.pendingState !== state) {
      throw new SyncAuthError("invalid_state");
    }
    if (!(await this.deps.hasConsent(userId))) throw new SyncAuthError("consent_required");
    try {
      const tokens = await this.deps.google.exchangeCode(code);
      await this.deps.google.testWrite(target, tokens.accessToken);
      const next: LinkRecord = {
        ...link,
        state: "ready",
        pendingState: null,
        refreshTokenEnc: encryptToken(tokens.refreshToken, this.deps.encryptionKey),
      };
      await this.deps.store.put(next);
      return toStatus(next);
    } catch {
      await this.deps.store.put({ ...link, state: "error", pendingState: null });
      throw new SyncAuthError("link_failed");
    }
  }

  async status(userId: string): Promise<{ links: LinkStatus[] }> {
    return { links: (await this.deps.store.list(userId)).map(toStatus) };
  }

  /**
   * Returns a fresh access token for an internal Google call, or null when the
   * link is not usable. Consent is checked before anything else, so a revoked
   * consent never reaches Google.
   */
  async accessToken(userId: string, target: SyncTarget): Promise<string | null> {
    const link = await this.deps.store.get(userId, target);
    if (!link || link.state === "revoked" || !link.refreshTokenEnc) return null;
    if (!(await this.deps.hasConsent(userId))) {
      await this.markRevoked(link);
      return null;
    }
    const refresh = decryptToken(link.refreshTokenEnc, this.deps.encryptionKey);
    return (await this.deps.google.refreshAccessToken(refresh)).accessToken;
  }

  /** Consent revoked (event `consent.revoked`): drop the tokens, no further writes. */
  async revokeConsent(userId: string): Promise<void> {
    for (const link of await this.deps.store.list(userId)) await this.markRevoked(link);
  }

  private async markRevoked(link: LinkRecord): Promise<void> {
    await this.deps.store.put({
      ...link,
      state: "revoked",
      pendingState: null,
      refreshTokenEnc: null,
    });
  }
}
