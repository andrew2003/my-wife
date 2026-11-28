import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp, createMemoryStore } from "../src/index";

function setup() {
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" });
  const store = createMemoryStore();
  const app = createApp(config, { store });
  return { app, store };
}

const user = {
  id: "u1",
  email: "a@example.test",
  state: "active" as const,
  role: "user" as const,
  locale: "vi" as const,
  lastSeenAt: null,
  activatedEventAt: null,
};

describe("PUT /profile/locale", () => {
  it("stores the language in the profile", async () => {
    const { app, store } = setup();
    await store.insertUser(user);
    const res = await app.inject({
      method: "PUT",
      url: "/profile/locale",
      headers: { "x-user-id": "u1" },
      payload: { locale: "en" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { locale: "en" } });
    expect((await store.findUserById("u1"))?.locale).toBe("en");
  });

  it("rejects an unknown language", async () => {
    const { app, store } = setup();
    await store.insertUser(user);
    for (const payload of [{ locale: "fr" }, {}, { locale: 1 }]) {
      const res = await app.inject({
        method: "PUT",
        url: "/profile/locale",
        headers: { "x-user-id": "u1" },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("identity.invalid_locale");
    }
    expect((await store.findUserById("u1"))?.locale).toBe("vi");
  });

  it("needs a caller and an existing user", async () => {
    const { app } = setup();
    const anon = await app.inject({
      method: "PUT",
      url: "/profile/locale",
      payload: { locale: "en" },
    });
    expect(anon.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "PUT",
      url: "/profile/locale",
      headers: { "x-user-id": "nobody" },
      payload: { locale: "en" },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
