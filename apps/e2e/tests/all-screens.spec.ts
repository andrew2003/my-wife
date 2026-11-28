import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ConsoleMessage, type Response } from "@playwright/test";
import { DEMO_LOGIN_URL } from "../support/env";

/**
 * Every route of the web app, found by walking `app/**\/page.tsx`, so a new screen is
 * covered without editing this file. Dynamic segments get a fixture value.
 */
const APP_DIR = new URL("../../web/app", import.meta.url).pathname;
const FIXTURE_IDS: Record<string, string> = { id: "0190a0a0-0000-7000-8000-00000000f001" };

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

test("every route loads cleanly at 360 px after a demo login", async ({ page }) => {
  const all = routes();
  expect(all.length).toBeGreaterThan(20);

  await page.setViewportSize({ width: 360, height: 800 });
  await test.step("sign in through the demo login", async () => {
    await page.goto(`${DEMO_LOGIN_URL}/demo-login`);
    await expect(page).toHaveURL(/127\.0\.0\.1/);
  });

  const problems: string[] = [];
  let current = "";
  page.on("response", (res: Response) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith("/api/") && res.status() >= 400) {
      problems.push(
        `${current}: ${res.request().method()} ${url.pathname} answered ${res.status()}`,
      );
    }
  });
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") problems.push(`${current}: console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`${current}: page error: ${err.message}`));

  for (const route of all) {
    await test.step(route, async () => {
      current = route;
      const res = await page.goto(route, { waitUntil: "load" });
      if (res && res.status() >= 400) problems.push(`${route}: page answered ${res.status()}`);
      await page.waitForLoadState("networkidle");
      const alerts = await page
        .locator('[role="alert"]:not(#__next-route-announcer__)')
        .allInnerTexts();
      for (const text of alerts) problems.push(`${route}: alert: ${text.trim().slice(0, 120)}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) problems.push(`${route}: horizontal scroll, ${overflow}px wider than 360`);
    });
  }

  expect(problems).toEqual([]);
});
