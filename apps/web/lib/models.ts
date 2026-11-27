import {
  HandoverResultSchema,
  ListKeysResponseSchema,
  type LlmKeyView,
  type SaveLlmKeyRequestSchema,
} from "@my-wife/contracts";
import type { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SwitchInput = z.infer<typeof SaveLlmKeyRequestSchema>;
export type HandoverResult = z.infer<typeof HandoverResultSchema>;

export type KeysResult =
  { status: "ready"; keys: LlmKeyView[] } | { status: "empty" } | { status: "error" };

export type SwitchResult =
  | { status: "done"; result: HandoverResult }
  | { status: "refused"; reason: string }
  | { status: "error" };

/** The API returns no part of a key, so the screen shows one fixed mask. */
export function maskKey(): string {
  return "•".repeat(8);
}

/** Lists the stored keys as views (provider, model, role, validity); never a secret. */
export async function loadKeys(doFetch: FetchLike = fetch): Promise<KeysResult> {
  try {
    const res = await doFetch("/api/keys", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = ListKeysResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    const { keys } = parsed.data.data;
    return keys.length === 0 ? { status: "empty" } : { status: "ready", keys };
  } catch {
    return { status: "error" };
  }
}

/**
 * Asks `ai` to switch a model: the candidate must pass the handover test first. The request
 * body holds the new key; nothing from it is returned, kept or logged here.
 */
export async function switchModel(
  input: SwitchInput,
  doFetch: FetchLike = fetch,
): Promise<SwitchResult> {
  try {
    const res = await doFetch("/api/models/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const data = (body as { ok?: boolean; data?: unknown } | null)?.data;
      const parsed = HandoverResultSchema.safeParse(data);
      return parsed.success ? { status: "done", result: parsed.data } : { status: "error" };
    }
    const code = (body as { error?: unknown } | null)?.error;
    if (res.status === 422 && code === "key_invalid") return { status: "refused", reason: code };
    if (res.status === 409 && code === "not_ready") return { status: "refused", reason: code };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export async function removeKey(keyId: string, doFetch: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await doFetch(`/api/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}
