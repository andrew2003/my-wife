import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import {
  DRIVE_FILE_SCOPE,
  GoogleAuthService,
  InMemoryLinkStore,
  type GoogleOAuthClient,
} from "../src/auth/google-auth";
import { decryptToken, encryptToken } from "../src/auth/token-crypto";

const KEY = "k".repeat(32);
const NOW = new Date("2026-11-27T00:00:00Z");

function fakeGoogle() {
  const calls: string[] = [];
  const client: GoogleOAuthClient = {
    buildAuthorizationUrl: (p) => {
      calls.push("url");
      return `https://accounts.example/auth?scope=${encodeURIComponent(p.scopes.join(" "))}&state=${p.state}`;
    },
    exchangeCode: async () => {
      calls.push("exchange");
      return { refreshToken: "refresh-secret-123", accessToken: "access-secret-456" };
    },
    testWrite: async () => {
      calls.push("testWrite");
    },
    refreshAccessToken: async () => {
      calls.push("refresh");
      return { accessToken: "a2" };
    },
    revoke: async () => {
      calls.push("revoke");
    },
  };
  return { client, calls };
}

function setup(consent = true) {
  const { client, calls } = fakeGoogle();
  const store = new InMemoryLinkStore();
  const consents = { granted: consent };
  const svc = new GoogleAuthService({
    google: client,
    store,
    encryptionKey: KEY,
    hasConsent: async () => consents.granted,
  });
  return { svc, store, calls, consents };
}

describe("token crypto", () => {
  it("round-trips and does not contain the plaintext", () => {
    const enc = encryptToken("secret-token", KEY);
    expect(enc).not.toContain("secret-token");
    expect(decryptToken(enc, KEY)).toBe("secret-token");
    expect(() => decryptToken(enc, "z".repeat(32))).toThrow();
  });
});

describe("google authorization", () => {
  it("requests the narrow drive.file scope, never the full drive scope", async () => {
    const { svc } = setup();
    const { authorizationUrl } = await svc.start("u1", "sheets", NOW);
    const scope = new URL(authorizationUrl).searchParams.get("scope") ?? "";
    expect(scope.split(" ")).toContain(DRIVE_FILE_SCOPE);
    expect(scope.split(" ")).not.toContain("https://www.googleapis.com/auth/drive");
  });

  it("refuses to start without google_sync consent and makes no Google call", async () => {
    const { svc, calls } = setup(false);
    await expect(svc.start("u1", "sheets", NOW)).rejects.toThrow(/consent/);
    expect(calls).toEqual([]);
  });

  it("stores the token encrypted and never returns it (criterion 1)", async () => {
    const { svc, store } = setup();
    const { state } = await svc.start("u1", "sheets", NOW);
    const status = await svc.complete("u1", "sheets", "code", state, NOW);
    expect(status.state).toBe("ready");
    const raw = JSON.stringify(store.dump());
    expect(raw).not.toContain("refresh-secret-123");
    expect(raw).not.toContain("access-secret-456");
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(JSON.stringify(await svc.status("u1"))).not.toContain("secret");
  });

  it("rejects an unknown state", async () => {
    const { svc } = setup();
    await svc.start("u1", "sheets", NOW);
    await expect(svc.complete("u1", "sheets", "c", "bad", NOW)).rejects.toThrow(/state/);
  });

  it("makes no Google call once consent is revoked (criterion 2)", async () => {
    const { svc, calls, consents } = setup();
    const { state } = await svc.start("u1", "sheets", NOW);
    await svc.complete("u1", "sheets", "code", state, NOW);
    calls.length = 0;
    consents.granted = false;
    const token = await svc.accessToken("u1", "sheets");
    expect(token).toBeNull();
    expect(calls).toEqual([]);
    expect((await svc.status("u1")).links[0]?.state).toBe("revoked");
  });

  it("revokeConsent marks revoked, drops the token and calls nothing afterwards", async () => {
    const { svc, store, calls } = setup();
    const { state } = await svc.start("u1", "sheets", NOW);
    await svc.complete("u1", "sheets", "code", state, NOW);
    await svc.revokeConsent("u1");
    expect(JSON.stringify(store.dump())).not.toContain('refreshTokenEnc":"');
    calls.length = 0;
    expect(await svc.accessToken("u1", "sheets")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("routes", () => {
  it("never exposes tokens over HTTP", async () => {
    const { client } = fakeGoogle();
    const store = new InMemoryLinkStore();
    const app = await createApp(loadConfig({ SESSION_SECRET: KEY, LOG_LEVEL: "silent" }), {
      syncAuth: { google: client, store, hasConsent: async () => true, now: () => NOW },
    });
    const start = await app.inject({
      method: "POST",
      url: "/sync/link/start",
      headers: { "x-user-id": "u1" },
      payload: { target: "sheets" },
    });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().data.authorizationUrl).searchParams.get("state");
    const cb = await app.inject({
      method: "POST",
      url: "/sync/link/callback",
      headers: { "x-user-id": "u1" },
      payload: { target: "sheets", code: "c", state },
    });
    expect(cb.statusCode).toBe(200);
    const status = await app.inject({
      method: "GET",
      url: "/sync/status",
      headers: { "x-user-id": "u1" },
    });
    expect(status.json().data.links[0]).toMatchObject({ target: "sheets", state: "ready" });
    expect(cb.body + status.body).not.toContain("secret");
  });
});
