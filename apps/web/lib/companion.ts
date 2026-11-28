import { z } from "zod";
import type { Locale } from "./i18n";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The dashboard has its own character and the focus session must stay quiet. */
const NO_PANEL_ROUTES: readonly string[] = ["/", "/monitor"];

export function showsCompanion(pathname: string): boolean {
  return !NO_PANEL_ROUTES.includes(pathname);
}

/**
 * Screen key for the remark cache: the static path segments joined with a dash. A dynamic
 * segment (an id) is dropped so every receipt page shares one remark per day.
 */
export function remarkScreen(pathname: string): string {
  const parts = pathname
    .split("/")
    .filter((p) => /^[a-z][a-z-]*$/.test(p))
    .slice(0, 3);
  return parts.length === 0 ? "home" : parts.join("-");
}

// Shape of the `ai` service reply to POST /remarks; the text is already number-checked there.
const RemarkResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ text: z.string().min(1), source: z.enum(["model", "fallback"]) }),
});

export type RemarkResult =
  | { status: "ready"; text: string; source: "model" | "fallback" }
  | { status: "error" };

/**
 * Asks `ai` for the remark of a screen. The service answers from its daily cache, so this is
 * cheap to repeat. No facts are sent from here: the page text is not a source of numbers.
 */
export async function loadRemark(
  screen: string,
  locale: Locale,
  doFetch: FetchLike = fetch,
): Promise<RemarkResult> {
  try {
    const res = await doFetch("/api/ai/remarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screen, facts: {}, locale }),
    });
    if (!res.ok) return { status: "error" };
    const parsed = RemarkResponseSchema.safeParse(await res.json());
    return parsed.success ? { status: "ready", ...parsed.data.data } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}
