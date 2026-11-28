"use client";

import { useEffect } from "react";

/**
 * Writes the profile language into the language cookie when the cookie is missing,
 * so a change made from a chat channel takes effect at the next visit.
 */
export function LocaleCookieSync({ profileLocale }: { profileLocale: string }) {
  useEffect(() => {
    if (document.cookie.split("; ").some((c) => c.startsWith("mw_locale="))) return;
    document.cookie = `mw_locale=${profileLocale}; path=/; max-age=31536000; samesite=lax`;
  }, [profileLocale]);
  return null;
}
