import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";

describe("PUT /api/profile/locale", () => {
  it("is proxied to identity with the verified user id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "http://identity/sessions/verify") {
        return new Response(JSON.stringify({ ok: true, data: { user: { id: "u1" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, data: { locale: "en" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const app = createApp(
      loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" }),
      {},
      {
        fetch: fetchStub,
        upstreams: {
          identity: "http://identity",
          budget: "http://budget",
          schedule: "http://schedule",
          rules: "http://rules",
        },
      },
    );
    const res = await app.inject({
      method: "PUT",
      url: "/api/profile/locale",
      headers: { cookie: "mw_session=tok" },
      payload: { locale: "en" },
    });
    expect(res.statusCode).toBe(200);
    const proxied = calls.find((c) => c.url === "http://identity/profile/locale");
    expect(proxied?.init?.method).toBe("PUT");
    expect((proxied?.init?.headers as Record<string, string>)["x-user-id"]).toBe("u1");
    expect(proxied?.init?.body).toBe(JSON.stringify({ locale: "en" }));
    const anon = await app.inject({
      method: "PUT",
      url: "/api/profile/locale",
      payload: { locale: "en" },
    });
    expect(anon.statusCode).toBe(401);
  });
});
