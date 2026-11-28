"use client";

import { useEffect } from "react";

/**
 * Keeps the language cookie equal to the profile language. The profile wins for a signed-in
 * user, so a change made from a chat channel takes effect at the next visit and the cookie
 * (used on the sign-in page) does not stay stale.
 */
export function LocaleCookieSync({ profileLocale }: { profileLocale: string }) {
  useEffect(() => {
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith("mw_locale="))
      ?.slice("mw_locale=".length);
    if (current === profileLocale) return;
    document.cookie = `mw_locale=${profileLocale}; path=/; max-age=31536000; samesite=lax`;
  }, [profileLocale]);
  return null;
}
