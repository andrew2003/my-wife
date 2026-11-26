import { UserSchema } from "@my-wife/contracts";
import type { z } from "zod";

export const SESSION_COOKIE = "mw_session";
export const LOCALE_COOKIE = "mw_locale";

export type CurrentUser = z.infer<typeof UserSchema>;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Asks the gateway who the session cookie belongs to. Any failure means anonymous. */
export async function fetchCurrentUser(
  token: string | undefined,
  gatewayUrl: string,
  doFetch: FetchLike = fetch,
): Promise<CurrentUser | null> {
  if (!token) return null;
  try {
    const res = await doFetch(`${gatewayUrl}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { user?: unknown } };
    const parsed = UserSchema.safeParse(body.data?.user);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
