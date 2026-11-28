import type { ReactNode } from "react";
import { AppShell } from "../components/app-shell";
import { SignInPage, type LoginMethod } from "../components/sign-in-page";
import { translate } from "../lib/i18n";
import { getRequestContext, getRequestLocale } from "../lib/request-context";
import { themeColors } from "../lib/theme";
import "./tokens.css";
import "./globals.css";

export async function generateMetadata() {
  const locale = await getRequestLocale();
  return {
    title: translate(locale, "app.name"),
    description: translate(locale, "app.description"),
    manifest: "/manifest.webmanifest",
  };
}

export async function generateViewport() {
  const { appearance } = await getRequestContext();
  const colors = themeColors(appearance.skin);
  return {
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: colors.light },
      { media: "(prefers-color-scheme: dark)", color: colors.dark },
    ],
  };
}

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, user, appearance } = await getRequestContext();
  const loginMethod: LoginMethod =
    process.env.LOGIN_METHOD === "magic_link" ? "magic_link" : "google";
  return (
    <html
      lang={locale}
      data-skin={appearance.skin}
      data-mode={appearance.mode === "system" ? undefined : appearance.mode}
    >
      <body>
        {user ? (
          <AppShell locale={locale} user={user}>
            {children}
          </AppShell>
        ) : (
          <SignInPage locale={locale} loginMethod={loginMethod} />
        )}
      </body>
    </html>
  );
}
