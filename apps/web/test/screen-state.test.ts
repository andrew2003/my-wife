import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtContext } from "../components/art-context";
import { DebtsView } from "../components/debts-view";
import { ScreenState, stateKeys } from "../components/screen-state";
import { defaultExpressionSettings, type ExpressionSettings } from "../lib/expressions";
import { translate } from "../lib/i18n";
import { stateExpression } from "../lib/screen-state";

const base = { locale: "en" as const, keys: stateKeys("debts"), onRetry: () => undefined };

describe("ScreenState", () => {
  it("shows a labelled skeleton while loading", () => {
    const html = renderToStaticMarkup(h(ScreenState, { ...base, kind: "loading" }));
    expect(html).toContain("mw-skeleton");
    expect(html).toContain(translate("en", "debts.loading"));
  });

  it("shows the empty state with the active expression art", () => {
    const html = renderToStaticMarkup(h(ScreenState, { ...base, kind: "empty" }));
    expect(html).toContain("mw-state-empty");
    expect(html).toContain(translate("en", "debts.empty"));
    expect(html).toContain("fallback-art");
  });

  it("uses the mapped expression of the active set when art exists", () => {
    const expressions: ExpressionSettings = { ...defaultExpressionSettings(), set: "silver_face" };
    const html = renderToStaticMarkup(
      h(
        ArtContext.Provider,
        { value: { available: true, expressions } },
        h(ScreenState, { ...base, kind: "empty" }),
      ),
    );
    expect(html).toContain("silver-face-greet");
  });

  it("shows a retryable error state", () => {
    const html = renderToStaticMarkup(h(ScreenState, { ...base, kind: "error" }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(translate("en", "debts.error"));
    expect(html).toContain(translate("en", "debts.retry"));
  });

  it("maps empty and error to expression states", () => {
    expect(stateExpression("empty")).toBe("greeting");
    expect(stateExpression("error")).toBe("news");
  });
});

describe("screens use the shared states", () => {
  for (const status of ["loading", "empty", "error"] as const) {
    it(`DebtsView renders the shared ${status} state`, () => {
      const html = renderToStaticMarkup(
        h(DebtsView, {
          locale: "en",
          status,
          debts: [],
          timeZone: "UTC",
          onRefresh: () => undefined,
        }),
      );
      const marker = { loading: "mw-skeleton", empty: "mw-state-empty", error: "mw-state-error" }[
        status
      ];
      expect(html).toContain(marker);
    });
  }

  it("every view with a loading status uses ScreenState or the shared ui states", () => {
    const dir = join(import.meta.dirname, "..", "components");
    const allow = new Set(["companion-panel-view.tsx", "onboarding-wizard-view.tsx"]);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith("-view.tsx") && !allow.has(f))
      .filter((f) => {
        const src = readFileSync(join(dir, f), "utf8");
        if (!src.includes('"loading"')) return false;
        return !/ScreenState|<Skeleton/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it("has loading, error and retry copy in both locales for the shared keys", () => {
    for (const ns of ["debts", "anomalies", "fault", "funding", "penalty", "review", "weekplan"]) {
      for (const locale of ["vi", "en"] as const) {
        for (const part of ["loading", "error", "retry"]) {
          const key = `${ns}.${part}`;
          expect(translate(locale, key), key).not.toBe(key);
        }
      }
    }
  });
});
