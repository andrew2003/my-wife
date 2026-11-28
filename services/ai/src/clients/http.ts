/** Shared shape of the internal REST envelope: `{ ok: true, data }` or `{ ok: false, error }`. */
export class InternalCallError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
  ) {
    super(`${service} call failed with status ${status}`);
    this.name = "InternalCallError";
  }
}

/**
 * POSTs JSON to another service on behalf of one user (`x-user-id`). Throws
 * `InternalCallError` on any non-2xx answer or an answer without `ok: true`. The body is never
 * put into the error, so message text cannot reach logs.
 */
export async function postJson(
  fetchFn: typeof fetch,
  service: string,
  url: string,
  userId: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": userId },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new InternalCallError(service, res.status);
  const parsed = (await res.json()) as { ok?: boolean; data?: unknown };
  if (parsed.ok !== true) throw new InternalCallError(service, res.status);
  return parsed.data;
}

/** GETs one read route on behalf of one user and returns the envelope data. */
export async function getJson(
  fetchFn: typeof fetch,
  service: string,
  url: string,
  userId: string,
): Promise<unknown> {
  const res = await fetchFn(url, { method: "GET", headers: { "x-user-id": userId } });
  if (!res.ok) throw new InternalCallError(service, res.status);
  const parsed = (await res.json()) as { ok?: boolean; data?: unknown };
  if (parsed.ok !== true) throw new InternalCallError(service, res.status);
  return parsed.data;
}
