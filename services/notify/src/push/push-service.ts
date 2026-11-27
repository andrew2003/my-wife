import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "@my-wife/contracts";
import { blindIndex, open, seal } from "./secret-box";
import { vapidAuthorization, type VapidConfig } from "./vapid";

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Stored record: endpoint and keys are sealed, only a keyed hash is searchable. */
export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpointIndex: string;
  sealed: string;
  createdAt: string;
}

export interface PushStore {
  findByEndpoint(userId: string, endpointIndex: string): StoredPushSubscription | undefined;
  listByUser(userId: string): StoredPushSubscription[];
  add(record: StoredPushSubscription): void;
  remove(id: string): void;
}

export class InMemoryPushStore implements PushStore {
  private records = new Map<string, StoredPushSubscription>();
  findByEndpoint(userId: string, endpointIndex: string) {
    return [...this.records.values()].find(
      (r) => r.userId === userId && r.endpointIndex === endpointIndex,
    );
  }
  listByUser(userId: string) {
    return [...this.records.values()].filter((r) => r.userId === userId);
  }
  add(record: StoredPushSubscription) {
    this.records.set(record.id, record);
  }
  remove(id: string) {
    this.records.delete(id);
  }
  /** Test helper: everything as persisted. */
  dump() {
    return [...this.records.values()];
  }
}

export interface SendResult {
  delivered: number;
  removed: number;
  failed: number;
  /** True when the message class is not pushed (only urgent and wake-up are). */
  skipped: boolean;
}

export interface PushServiceDeps {
  store: PushStore;
  vapid: VapidConfig;
  /** 32-byte AES-256-GCM key. */
  secretKey: Buffer;
  now: () => Date;
  fetch?: typeof fetch;
  /** Log sink; never receives endpoints or keys. */
  log?: (line: string) => void;
  /** Push message time to live; default one day. */
  ttlSeconds?: number;
  /** Tests only: accept `http` endpoints of the emulated push service. */
  allowInsecureEndpoints?: boolean;
}

export interface PushService {
  subscribe(userId: string, input: PushSubscriptionInput): Promise<{ id: string }>;
  unsubscribe(userId: string, endpoint: string): Promise<void>;
  send(userId: string, message: OutboundMessage): Promise<SendResult>;
}

const DEFAULT_TTL_SECONDS = 86_400;

export class InvalidPushEndpointError extends Error {}

export function createPushService(deps: PushServiceDeps): PushService {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const ttl = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  function checkEndpoint(endpoint: string): URL {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(deps.allowInsecureEndpoints && url.protocol === "http:")) {
      throw new InvalidPushEndpointError("push endpoint must use https");
    }
    return url;
  }

  return {
    async subscribe(userId, input) {
      checkEndpoint(input.endpoint);
      const endpointIndex = blindIndex(deps.secretKey, input.endpoint);
      const existing = deps.store.findByEndpoint(userId, endpointIndex);
      if (existing) return { id: existing.id };
      const record: StoredPushSubscription = {
        id: randomUUID(),
        userId,
        endpointIndex,
        sealed: seal(deps.secretKey, JSON.stringify(input), userId),
        createdAt: deps.now().toISOString(),
      };
      deps.store.add(record);
      return { id: record.id };
    },

    async unsubscribe(userId, endpoint) {
      const found = deps.store.findByEndpoint(userId, blindIndex(deps.secretKey, endpoint));
      if (found) deps.store.remove(found.id);
    },

    async send(userId, message) {
      const result: SendResult = { delivered: 0, removed: 0, failed: 0, skipped: false };
      if (message.class !== "urgent" && !message.isWakeUp) {
        return { ...result, skipped: true };
      }
      for (const record of deps.store.listByUser(userId)) {
        const sub = JSON.parse(
          open(deps.secretKey, record.sealed, userId),
        ) as PushSubscriptionInput;
        try {
          const url = checkEndpoint(sub.endpoint);
          // The body is empty: no personal content leaves the service (ADR M3 web push).
          const res = await doFetch(sub.endpoint, {
            method: "POST",
            redirect: "manual",
            headers: {
              Authorization: vapidAuthorization(deps.vapid, url.origin, deps.now(), 12 * 3600),
              TTL: String(ttl),
              Urgency: "high",
              "Content-Length": "0",
            },
          });
          if (res.status === 404 || res.status === 410) {
            deps.store.remove(record.id);
            result.removed += 1;
            log(`push subscription ${record.id} removed: gone`);
          } else if (res.status >= 200 && res.status < 300) {
            result.delivered += 1;
          } else {
            result.failed += 1;
            log(`push to subscription ${record.id} failed: status ${res.status}`);
          }
        } catch {
          result.failed += 1;
          log(`push to subscription ${record.id} failed: network error`);
        }
      }
      return result;
    },
  };
}
