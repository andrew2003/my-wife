import { DEMO_LOGIN_PORT } from "./demo-login";

/**
 * Read paths the web calls through the gateway, probed with GET. Write-only paths (sign-in,
 * heartbeat, task start and complete, consent signing) are left out so a probe never changes
 * state. A path with a dynamic segment uses a fixed sample id.
 */
export const PROBE_PATHS = [
  "/api/me",
  "/api/settings",
  "/api/budget/overview",
  "/api/budget/funding",
  "/api/budget/debts",
  "/api/budget/exceptions",
  "/api/budget/sample-cycle",
  "/api/budget/weekly-menu",
  "/api/budget/wishlist",
  "/api/weeks/current",
  "/api/tasks",
  "/api/sample-schedule",
  "/api/sessions/active",
  "/api/wake/today",
  "/api/checklist",
  "/api/notify/inbox",
  "/api/faults",
  "/api/appeals",
  "/api/penalties",
  "/api/rewards",
  "/api/keys",
  "/api/consents",
  "/api/contracts/status",
  "/api/onboarding/steps",
  "/api/templates",
  "/api/sender-map",
  "/api/invitations",
  "/api/admin/audit",
  "/api/admin/feature-flags",
  "/api/admin/incidents",
  "/api/admin/invitations",
  "/api/admin/sender-map",
] as const;

export interface ProbeOptions {
  /** Base URL of the sign-in helper, for example http://127.0.0.1:4100. */
  loginUrl: string;
  /** Base URL that serves `/api/*`: the gateway (4000) or the web origin that proxies to it. */
  apiUrl: string;
  paths?: readonly string[];
  timeoutMs?: number;
}

export interface ProbeResult {
  results: { path: string; status: number }[];
  /** Paths that did not answer 2xx; status 0 means no answer. */
  failing: string[];
}

/** Takes `name=value` from the first Set-Cookie header; the value is never printed. */
function sessionCookie(response: Response): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]?.trim();
    if (pair?.startsWith("mw_session=")) return pair;
  }
  return undefined;
}

async function statusOf(url: string, cookie: string, timeoutMs: number): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

/** Logs in through `/demo-login`, then records the HTTP status of each path. Never throws on a bad status. */
export async function runApiProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const login = await fetch(new URL("/demo-login", opts.loginUrl), {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await login.body?.cancel();
  const cookie = sessionCookie(login);
  if (!cookie) throw new Error(`demo login did not set a session cookie (status ${login.status})`);

  const results: ProbeResult["results"] = [];
  for (const path of opts.paths ?? PROBE_PATHS) {
    results.push({
      path,
      status: await statusOf(new URL(path, opts.apiUrl).toString(), cookie, timeoutMs),
    });
  }
  const failing = results.filter((r) => r.status < 200 || r.status >= 300).map((r) => r.path);
  return { results, failing };
}

export function formatProbeReport(result: ProbeResult): string {
  const lines = result.results.map((r) => `${r.status === 0 ? "ERR" : r.status} ${r.path}`);
  lines.push(
    `${result.results.length - result.failing.length}/${result.results.length} paths answered 2xx`,
  );
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const loginUrl = process.env.PROBE_LOGIN_URL ?? `http://127.0.0.1:${DEMO_LOGIN_PORT}`;
  const apiUrl = process.env.PROBE_API_URL ?? "http://127.0.0.1:4000";
  const result = await runApiProbe({ loginUrl, apiUrl });
  console.log(formatProbeReport(result));
}
