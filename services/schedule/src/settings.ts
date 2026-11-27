/**
 * Reads the user's effective settings from identity (`GET /settings` with `x-user-id`).
 * Returns an empty object on any failure so callers fall back to registry defaults.
 */
export function createSettingsReader(
  identityUrl: string | (() => string),
  fetchFn: typeof fetch = fetch,
): (userId: string) => Promise<Record<string, unknown>> {
  return async (userId) => {
    try {
      const res = await fetchFn(
        `${typeof identityUrl === "function" ? identityUrl() : identityUrl}/settings`,
        { headers: { "x-user-id": userId } },
      );
      if (!res.ok) return {};
      const body = (await res.json()) as { ok?: boolean; data?: { values?: unknown } };
      const values = body.data?.values;
      return body.ok && values && typeof values === "object"
        ? (values as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
}
