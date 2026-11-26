type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SignResult = { ok: true } | { ok: false; errorKey: string };

async function post(doFetch: FetchLike, url: string, body: unknown): Promise<boolean> {
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Signs the commitment contract of the first cycle and then completes the last onboarding
 * step. Signing is idempotent in the rules service, so a retry after a failed step is safe.
 */
export async function signContract(
  cycleId: string | undefined,
  deps: { fetch?: FetchLike } = {},
): Promise<SignResult> {
  if (!cycleId) return { ok: false, errorKey: "contract.error.no_cycle" };
  const doFetch = deps.fetch ?? fetch;
  if (!(await post(doFetch, "/api/contracts/sign", { cycleId }))) {
    return { ok: false, errorKey: "contract.error.sign" };
  }
  if (!(await post(doFetch, "/api/onboarding/steps", { step: "sign_contract", skipped: false }))) {
    return { ok: false, errorKey: "contract.error.complete" };
  }
  return { ok: true };
}
