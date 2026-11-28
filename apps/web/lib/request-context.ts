import { cookies, headers } from "next/headers";
import { resolveGatewayUrl } from "./gateway-url.mjs";
import type { Locale } from "./i18n";
import { resolveLocale } from "./locale";
import { MODE_COOKIE, parseMode, parseSkin, SKIN_COOKIE, type Mode, type Skin } from "./theme";
import { fetchCurrentUser, LOCALE_COOKIE, SESSION_COOKIE, type CurrentUser } from "./session";

export interface RequestContext {
  locale: Locale;
  user: CurrentUser | null;
  appearance: { skin: Skin; mode: Mode };
}

/** Locale: cookie, profile, Accept-Language, then UI_LANGUAGE. */
export async function getRequestContext(): Promise<RequestContext> {
  const store = await cookies();
  const gateway = resolveGatewayUrl(process.env);
  const user = await fetchCurrentUser(store.get(SESSION_COOKIE)?.value, gateway);
  const locale = resolveLocale({
    cookie: store.get(LOCALE_COOKIE)?.value,
    profile: user?.locale,
    signedIn: user !== null,
    acceptLanguage: (await headers()).get("accept-language"),
  });
  const appearance = {
    skin: parseSkin(store.get(SKIN_COOKIE)?.value),
    mode: parseMode(store.get(MODE_COOKIE)?.value),
  };
  return { locale, user, appearance };
}

/** The locale of the current request, for pages and metadata. */
export async function getRequestLocale(): Promise<Locale> {
  return (await getRequestContext()).locale;
}
