import { translate, type Locale } from "../lib/i18n";
import { LocaleSwitch } from "./locale-switch";

export type LoginMethod = "google" | "magic_link";

export function SignInPage({ locale, loginMethod }: { locale: Locale; loginMethod: LoginMethod }) {
  const t = (key: string) => translate(locale, key);
  return (
    <main className="signin">
      <h1>{t("signin.title")}</h1>
      {loginMethod === "google" ? (
        <a className="button" href="/api/auth/google">
          {t("signin.google")}
        </a>
      ) : (
        <a className="button" href="/api/auth/magic-link">
          {t("signin.magic_link")}
        </a>
      )}
      <p>{t("signin.invitation_only")}</p>
      <LocaleSwitch locale={locale} />
    </main>
  );
}
