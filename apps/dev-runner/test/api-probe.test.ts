import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_PATHS, formatProbeReport, runApiProbe } from "../src/api-probe";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function start(app: ReturnType<typeof Fastify>): Promise<string> {
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

describe("api probe", () => {
  it("logs in via /demo-login and records the status of every path", async () => {
    const login = Fastify();
    login.get("/demo-login", async (_r, reply) =>
      reply.header("set-cookie", "mw_session=abc; Path=/; HttpOnly").redirect("http://x/", 302),
    );
    const gateway = Fastify();
    const seen: string[] = [];
    gateway.get("/*", async (req, reply) => {
      seen.push(String(req.headers.cookie));
      return reply.code(req.url === "/api/faults" ? 404 : 200).send({});
    });
    const result = await runApiProbe({
      loginUrl: await start(login),
      apiUrl: await start(gateway),
    });
    expect(result.results.map((r) => r.path)).toEqual([...PROBE_PATHS]);
    expect(result.results.find((r) => r.path === "/api/faults")?.status).toBe(404);
    expect(result.results.find((r) => r.path === "/api/me")?.status).toBe(200);
    expect(seen.every((c) => c === "mw_session=abc")).toBe(true);
    expect(result.failing).toEqual(["/api/faults"]);
    const report = formatProbeReport(result);
    expect(report).toContain("404 /api/faults");
    expect(report).not.toContain("abc");
  });

  it("records a network error as status 0 instead of throwing", async () => {
    const login = Fastify();
    login.get("/demo-login", async (_r, reply) =>
      reply.header("set-cookie", "mw_session=abc").redirect("http://x/", 302),
    );
    const result = await runApiProbe({
      loginUrl: await start(login),
      apiUrl: "http://127.0.0.1:1",
    });
    expect(result.results.every((r) => r.status === 0)).toBe(true);
  });

  it("fails clearly when the login sets no session cookie", async () => {
    const login = Fastify();
    login.get("/demo-login", async () => "no cookie");
    await expect(
      runApiProbe({ loginUrl: await start(login), apiUrl: "http://127.0.0.1:1" }),
    ).rejects.toThrow(/session cookie/);
  });

  it("covers the paths the web reads", () => {
    for (const p of [
      "/api/budget/overview",
      "/api/budget/funding",
      "/api/weeks/current",
      "/api/notify/inbox",
      "/api/faults",
      "/api/keys",
    ]) {
      expect(PROBE_PATHS).toContain(p);
    }
  });
});
