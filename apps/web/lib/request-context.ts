import { cookies } from "next/headers";
import { resolveGatewayUrl } from "./gateway-url.mjs";
import { defaultLocale, type Locale } from "./i18n";
import { fetchCurrentUser, LOCALE_COOKIE, SESSION_COOKIE, type CurrentUser } from "./session";

export interface RequestContext {
  locale: Locale;
  user: CurrentUser | null;
}

/** Locale: cookie choice, then the user's stored locale, then UI_LANGUAGE. */
export async function getRequestContext(): Promise<RequestContext> {
  const store = await cookies();
  const gateway = resolveGatewayUrl(process.env);
  const user = await fetchCurrentUser(store.get(SESSION_COOKIE)?.value, gateway);
  const chosen = store.get(LOCALE_COOKIE)?.value;
  const fallback = defaultLocale(process.env.UI_LANGUAGE);
  const locale = chosen === "vi" || chosen === "en" ? chosen : (user?.locale ?? fallback);
  return { locale, user };
}
