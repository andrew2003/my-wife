import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { OutboundMessage } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { createPushService, InMemoryPushStore, type PushService } from "../src/push/push-service";
import { startEmulatedPush, type EmulatedPush } from "./helpers/emulated-push";

const SECRET_KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-11-27T10:00:00.000Z");
const keys = { p256dh: "BPubKey", auth: "authSecret" };

function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x as string, "base64url"),
    Buffer.from(pub.y as string, "base64url"),
  ]);
  return {
    subject: "mailto:ops@example.test",
    publicKey: raw.toString("base64url"),
    privateKey: jwk.d as string,
  };
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: "7b0f6f58-0c52-4a3c-9a43-2a0f4b1b9a11",
    class: "urgent",
    message: { key: "notify.test_message", params: {} },
    locale: "vi",
    sourceService: "monitor",
    isWakeUp: false,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("web push", () => {
  let push: EmulatedPush;
  let store: InMemoryPushStore;
  let service: PushService;
  let vapid: ReturnType<typeof vapidKeys>;
  const logs: string[] = [];

  beforeEach(async () => {
    push = await startEmulatedPush();
    store = new InMemoryPushStore();
    vapid = vapidKeys();
    logs.length = 0;
    service = createPushService({
      store,
      vapid,
      secretKey: SECRET_KEY,
      allowInsecureEndpoints: true,
      now: () => NOW,
      log: (line) => logs.push(line),
    });
  });
  afterEach(async () => {
    await push.close();
  });

  it("delivers a notification to the subscribed browser endpoint", async () => {
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    const result = await service.send("u1", message());
    expect(result).toEqual({ delivered: 1, removed: 0, failed: 0, skipped: false });
    expect(push.received).toHaveLength(1);
    const req = push.received[0]!;
    expect(req.path).toBe("/sub/a");
    expect(req.headers.ttl).toBeDefined();
    expect(req.headers.urgency).toBe("high");
    expect(req.body.length).toBe(0);
  });

  it("signs a VAPID token that verifies against the public key", async () => {
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    await service.send("u1", message());
    const auth = String(push.received[0]!.headers.authorization);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
    expect(match).not.toBeNull();
    const [head, claims, sig] = match![1]!.split(".");
    const parsed = JSON.parse(Buffer.from(claims!, "base64url").toString());
    expect(parsed.aud).toBe(push.origin);
    expect(parsed.sub).toBe(vapid.subject);
    expect(parsed.exp).toBeGreaterThan(NOW.getTime() / 1000);
    expect(match![2]).toBe(vapid.publicKey);
    const pubRaw = Buffer.from(vapid.publicKey, "base64url");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: pubRaw.subarray(1, 33).toString("base64url"),
        y: pubRaw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(sig!, "base64url"),
      ),
    ).toBe(true);
  });

  it("sends to every device of the user and to no other user", async () => {
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/b`, keys });
    await service.subscribe("u2", { endpoint: `${push.origin}/sub/c`, keys });
    const result = await service.send("u1", message());
    expect(result.delivered).toBe(2);
    expect(push.received.map((r) => r.path).sort()).toEqual(["/sub/a", "/sub/b"]);
  });

  it("does not store a duplicate subscription for the same endpoint", async () => {
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    expect((await service.send("u1", message())).delivered).toBe(1);
  });

  it("removes a subscription the push service reports gone", async () => {
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    push.gone.add("/sub/a");
    expect(await service.send("u1", message())).toMatchObject({ delivered: 0, removed: 1 });
    push.received.length = 0;
    expect(await service.send("u1", message())).toMatchObject({ delivered: 0, removed: 0 });
    expect(push.received).toHaveLength(0);
  });

  it("keeps a subscription after a temporary failure and counts it", async () => {
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    push.failing.add("/sub/a");
    expect(await service.send("u1", message())).toMatchObject({ failed: 1, removed: 0 });
    push.failing.delete("/sub/a");
    expect((await service.send("u1", message())).delivered).toBe(1);
  });

  it("sends only urgent and wake-up messages", async () => {
    await service.subscribe("u1", { endpoint: `${push.origin}/sub/a`, keys });
    expect(await service.send("u1", message({ class: "digest" }))).toMatchObject({
      skipped: true,
      delivered: 0,
    });
    expect(push.received).toHaveLength(0);
    const wake = await service.send("u1", message({ class: "timed", isWakeUp: true }));
    expect(wake.delivered).toBe(1);
  });

  it("encrypts endpoints and keys at rest and never logs them", async () => {
    const endpoint = `${push.origin}/sub/secret-endpoint`;
    await service.subscribe("u1", { endpoint, keys });
    push.gone.add("/sub/secret-endpoint");
    await service.send("u1", message());
    await service.subscribe("u1", { endpoint, keys });
    const dump = JSON.stringify(store.dump());
    expect(dump).not.toContain("secret-endpoint");
    expect(dump).not.toContain(keys.auth);
    expect(logs.join("\n")).not.toContain("secret-endpoint");
    expect(logs.join("\n")).not.toContain(keys.auth);
  });

  it("serves subscribe and unsubscribe routes", async () => {
    const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
    const app = await createApp(config, { push: service });
    const body = { endpoint: `${push.origin}/sub/r`, keys };
    const anon = await app.inject({ method: "POST", url: "/push/subscriptions", payload: body });
    expect(anon.statusCode).toBe(401);
    const invalid = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: { "x-user-id": "u1" },
      payload: { endpoint: "nope" },
    });
    expect(invalid.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: { "x-user-id": "u1" },
      payload: body,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.body).not.toContain("sub/r");
    expect((await service.send("u1", message())).delivered).toBe(1);
    const del = await app.inject({
      method: "DELETE",
      url: "/push/subscriptions",
      headers: { "x-user-id": "u1" },
      payload: { endpoint: body.endpoint },
    });
    expect(del.statusCode).toBe(204);
    expect((await service.send("u1", message())).delivered).toBe(0);
    await app.close();
  });
});
