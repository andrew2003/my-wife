import type { ReactNode } from "react";
import { AppShell } from "../components/app-shell";
import { SignInPage, type LoginMethod } from "../components/sign-in-page";
import { translate } from "../lib/i18n";
import { getRequestContext, getRequestLocale } from "../lib/request-context";
import "./globals.css";

export async function generateMetadata() {
  const locale = await getRequestLocale();
  return {
    title: translate(locale, "app.name"),
    description: translate(locale, "app.description"),
    manifest: "/manifest.webmanifest",
  };
}

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, user } = await getRequestContext();
  const loginMethod: LoginMethod =
    process.env.LOGIN_METHOD === "magic_link" ? "magic_link" : "google";
  return (
    <html lang={locale}>
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
