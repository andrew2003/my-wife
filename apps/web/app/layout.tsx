import type { ReactNode } from "react";
import { defaultLocale, translate } from "../lib/i18n";

const locale = defaultLocale(process.env.UI_LANGUAGE);

export const metadata = {
  title: translate(locale, "app.name"),
  description: translate(locale, "app.description"),
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
