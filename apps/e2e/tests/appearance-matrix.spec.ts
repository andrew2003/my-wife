import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SkinSchema, ThemeModeSchema } from "@my-wife/contracts";
import { expect, test, type Response } from "@playwright/test";
import { DEMO_LOGIN_URL, WEB_URL } from "../support/env";

/**
 * Final verification (#544): every route of the web app, across every skin, every mode
 * and three widths. Routes come from `app/**\/page.tsx`, like the all-screens test.
 * Each route must answer, show no alert and not scroll horizontally.
 * The whole file takes about 11 minutes; run one skin per command, for example
 * `playwright test tests/appearance-matrix.spec.ts --grep "skin navy"`.
 */
const APP_DIR = new URL("../../web/app", import.meta.url).pathname;
const FIXTURE_IDS: Record<string, string> = { id: "0190a0a0-0000-7000-8000-00000000f001" };
const WIDTHS = [360, 768, 1440];

function routes(dir = APP_DIR, prefix = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) {
      if (name === "page.tsx") found.push(prefix || "/");
      continue;
    }
    const dynamic = /^\[(\w+)\]$/.exec(name);
    const segment = dynamic ? (FIXTURE_IDS[dynamic[1]!] ?? "fixture") : name;
    found.push(...routes(path, `${prefix}/${segment}`));
  }
  return found;
}

const ALL = routes();

for (const skin of SkinSchema.options) {
  for (const mode of ThemeModeSchema.options) {
    test(`skin ${skin}, mode ${mode}: every route at every width`, async ({ page, context }) => {
      test.setTimeout(300_000);
      await context.addCookies([
        { name: "mw_skin", value: skin, url: WEB_URL },
        { name: "mw_mode", value: mode, url: WEB_URL },
      ]);
      await page.emulateMedia({ colorScheme: mode === "dark" ? "dark" : "light" });
      await page.goto(`${DEMO_LOGIN_URL}/demo-login`);
      await expect(page).toHaveURL(/127\.0\.0\.1/);

      const problems: string[] = [];
      let current = "";
      page.on("response", (res: Response) => {
        const url = new URL(res.url());
        if (url.pathname.startsWith("/api/") && res.status() >= 400) {
          problems.push(`${current}: ${url.pathname} answered ${res.status()}`);
        }
      });
      page.on("pageerror", (err) => problems.push(`${current}: page error: ${err.message}`));

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ALL) {
          current = `${width}px ${route}`;
          const res = await page.goto(route, { waitUntil: "load" });
          if (res && res.status() >= 400)
            problems.push(`${current}: page answered ${res.status()}`);
          await page.waitForLoadState("networkidle");
          const html = page.locator("html");
          await expect(html).toHaveAttribute("data-skin", skin);
          if (mode === "system") await expect(html).not.toHaveAttribute("data-mode", /.+/);
          else await expect(html).toHaveAttribute("data-mode", mode);
          const alerts = await page
            .locator('[role="alert"]:not(#__next-route-announcer__)')
            .allInnerTexts();
          for (const text of alerts)
            problems.push(`${current}: alert: ${text.trim().slice(0, 120)}`);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (overflow > 0) problems.push(`${current}: horizontal scroll, ${overflow}px`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
}
