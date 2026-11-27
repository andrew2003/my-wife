/**
 * Network guard for focus monitoring (spec 21 section 7, principle 5). Wraps `fetch` so no request
 * can carry a video frame, except the consented appeal frame sent to one dedicated path.
 */

/** The only path that may carry an image: the appeal evidence frame (consent `vision_frame`). */
export const APPEAL_FRAME_PATH = "/api/appeals/frame";

/** Base64 runs this long are treated as binary payloads (a heartbeat or form never needs one). */
const LONG_BASE64 = /[A-Za-z0-9+/_-]{512,}={0,2}/;
const IMAGE_DATA = /data:(image|video)\//i;

function pathOf(input: RequestInfo | URL): string {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  try {
    return new URL(raw, "http://local").pathname;
  } catch {
    return raw;
  }
}

function blocked(reason: string): Error {
  return new Error(`frame guard: ${reason}`);
}

export function createFrameGuardedFetch(doFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathOf(input) === APPEAL_FRAME_PATH) return doFetch(input, init);

    if (typeof input === "object" && !(input instanceof URL) && "body" in input && input.body) {
      throw blocked("a Request object with a body cannot be inspected");
    }
    const type = new Headers(init?.headers).get("content-type") ?? "";
    if (/^(image|video)\//i.test(type) || /octet-stream|multipart/i.test(type)) {
      throw blocked(`content type ${type} may carry a frame`);
    }
    const body = init?.body;
    if (body !== undefined && body !== null) {
      if (typeof body !== "string" && !(body instanceof URLSearchParams)) {
        throw blocked("binary or stream body may carry a frame");
      }
      const text = String(body);
      if (IMAGE_DATA.test(text) || LONG_BASE64.test(text)) {
        throw blocked("body contains image data");
      }
    }
    return doFetch(input, init);
  }) as typeof fetch;
}
