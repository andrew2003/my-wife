import Fastify from "fastify";
import type { IdentityStore } from "@my-wife/identity";
import { createDemoWorld, DEMO_USER_ID, resetDemoState } from "./demo-state";
import { sign } from "./e2e-session";

export const DEMO_SESSION_ID = "0190a0a0-0000-7000-8000-0000000000d3";
export const DEMO_LOGIN_PORT = 4100;
const SESSION_DAYS = 30;
const COOKIE = "mw_session";

export type DemoLogin = {
  /** Base URL of the sign-in helper, for example http://127.0.0.1:4100. */
  url: string;
  stop(): Promise<void>;
};

export type DemoLoginOptions = {
  env: Record<string, string | undefined>;
  store: IdentityStore;
  secret: string;
  now: Date;
  /** Listen port; 0 lets the OS pick (tests). */
  port?: number;
};

/**
 * Manual demo sign-in (#292): with DEMO_LOGIN=1 it resets the demo user in the given store,
 * saves one session and serves GET /demo-login on 127.0.0.1, which sets that session as the
 * normal `mw_session` cookie and redirects to WEB_URL. Returns undefined when the flag is
 * unset. Throws at startup when NODE_ENV is production. The cookie value is only ever sent
 * in the Set-Cookie header of that response and is never logged.
 */
export async function prepareDemoLogin(opts: DemoLoginOptions): Promise<DemoLogin | undefined> {
  const { env, store, secret, now } = opts;
  if (env.DEMO_LOGIN !== "1") return undefined;
  if (env.NODE_ENV === "production") {
    throw new Error("DEMO_LOGIN must not be set when NODE_ENV is production");
  }
  const webUrl = new URL(env.WEB_URL ?? "http://localhost:3000").toString();

  await resetDemoState({ store, world: createDemoWorld(), now });
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await store.saveSession({
    id: DEMO_SESSION_ID,
    userId: DEMO_USER_ID,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
  });
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const value = sign({ sub: DEMO_USER_ID, sid: DEMO_SESSION_ID, exp }, secret);

  const app = Fastify({ logger: false });
  app.get("/demo-login", async (_req, reply) => {
    const maxAge = SESSION_DAYS * 86_400;
    return reply
      .header("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`)
      .header("cache-control", "no-store")
      .redirect(webUrl, 302);
  });
  await app.listen({ host: "127.0.0.1", port: opts.port ?? DEMO_LOGIN_PORT });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : DEMO_LOGIN_PORT;
  return { url: `http://127.0.0.1:${port}`, stop: () => app.close() };
}
