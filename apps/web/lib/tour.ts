type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TourStep {
  id: string;
  titleKey: string;
  bodyKey: string;
}

/** The screens the tour walks through, in order. Texts are locale keys. */
export const TOUR_STEPS: readonly TourStep[] = ["schedule", "budget", "inbox", "settings"].map(
  (id) => ({ id, titleKey: `tour.${id}.title`, bodyKey: `tour.${id}.body` }),
);

/** `unknown` (request failed) is treated like done: the tour is never forced on a doubt. */
export type TourState = "pending" | "done" | "unknown";

export async function loadTourState(doFetch: FetchLike = fetch): Promise<TourState> {
  try {
    const res = await doFetch("/api/onboarding/steps/tour", { cache: "no-store" });
    const body = (await res.json()) as { ok?: boolean; data?: { completed?: boolean } };
    if (!res.ok || !body.ok || typeof body.data?.completed !== "boolean") return "unknown";
    return body.data.completed ? "done" : "pending";
  } catch {
    return "unknown";
  }
}

/** Records the tour as finished (`skipped` false) or skipped; identity emits the event. */
export async function completeTour(skipped: boolean, doFetch: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await doFetch("/api/onboarding/steps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: "tour", skipped }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
