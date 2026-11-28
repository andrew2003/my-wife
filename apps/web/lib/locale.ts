import { configuredLocale, type Locale } from "./i18n";

const MAX_PATH_LENGTH = 512;

function asLocale(value: string | null | undefined): Locale | null {
  return value === "vi" || value === "en" ? value : null;
}

function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((e) => Number.isFinite(e.q) && e.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    if (base === "vi" || base === "en") return base;
  }
  return null;
}

/**
 * Locale order: cookie, profile, Accept-Language, then the configured default.
 * For a signed-in user the profile is the source of truth and comes first, because the
 * cookie can be stale after a change made from a chat channel; the cookie then only
 * serves visitors without a profile.
 */
export function resolveLocale(input: {
  cookie?: string | undefined;
  profile?: string | undefined;
  signedIn?: boolean | undefined;
  acceptLanguage?: string | null | undefined;
}): Locale {
  const profile = asLocale(input.profile);
  if (input.signedIn && profile) return profile;
  return (
    asLocale(input.cookie) ??
    profile ??
    fromAcceptLanguage(input.acceptLanguage) ??
    configuredLocale()
  );
}

function isSafePath(value: string): boolean {
  let current = value;
  for (let pass = 0; pass <= 2; pass++) {
    if (current.length === 0 || current.length > MAX_PATH_LENGTH) return false;
    if (!current.startsWith("/") || current.startsWith("//") || current.startsWith("/\\")) {
      return false;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\\\u0000-\u001f\u007f]/.test(current)) return false;
    const firstSegment = current.slice(1).split(/[/?#]/)[0] ?? "";
    if (firstSegment.includes("@") || firstSegment.includes(":")) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false;
    }
    if (decoded === current) return true;
    current = decoded;
  }
  // Still changing after two decoding passes: treat as unsafe.
  return false;
}

/** A same-origin relative path from `next`, else from `referer`, else "/". */
export function safeNextPath(
  next: string | null | undefined,
  referer: string | null | undefined,
  host: string,
): string {
  if (next && isSafePath(next)) return next;
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.host === host) {
        const path = `${url.pathname}${url.search}${url.hash}`;
        if (isSafePath(path)) return path;
      }
    } catch {
      // not a URL
    }
  }
  return "/";
}
