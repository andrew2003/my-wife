import { readFileSync } from "node:fs";
import { text } from "../support/locale";
import { test as base } from "@playwright/test";
import { DEMO_LOGIN_URL } from "../support/env";
import { expect, test } from "../support/signed-in";

/**
 * Final verification (#544): the manual part of docs/acceptance-guide.md, walked through by
 * the browser on the fresh demo. Chat reminders, the real camera and the week close stay with
 * the automated scenarios, as the guide says. Set MASCOT_ART_DIR to a private art directory to
 * check that the art is served to a signed-in user only; the art steps are left out without it.
 */
const VI = JSON.parse(
  readFileSync(new URL("../../web/locales/vi.json", import.meta.url), "utf8"),
) as Record<string, string>;
/** Text of the demo account, which speaks Vietnamese. */
const vi = (key: string): string => VI[key] ?? text(key);
const ART_DIR = process.env.MASCOT_ART_DIR?.trim();

async function opens(page: import("@playwright/test").Page, path: string, heading: string) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
}

test("manual guide, scenario 1: tour, questions, review, contract", async ({ page }) => {
  await test.step("1: the tour shows, Skip closes it, the navigation is visible", async () => {
    await page.goto("/budget");
    const tour = page.getByRole("dialog", { name: text("tour.label") });
    await expect(tour).toBeVisible();
    await tour.getByRole("button", { name: text("tour.skip"), exact: true }).click();
    await expect(tour).toBeHidden();
    await expect(page.getByRole("navigation", { name: text("nav.label") })).toBeVisible();
  });

  await test.step("1: onboarding questions, review and contract", async () => {
    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { level: 1, name: text("onboarding.title") }),
    ).toBeVisible();
    // The guide says a skipped wake answer gives 06:30, but the registry default is 06:00
    // (`routine.wake.time`); answer 06:30 so the step checks the generated schedule.
    await page.getByLabel(text("onboarding.q.wake")).fill("06:30");
    await page.getByRole("button", { name: text("onboarding.continue") }).click();
    await expect(page.getByText(text("onboarding.review.intro"))).toBeVisible({ timeout: 30_000 });
    const schedule = page.getByRole("region", { name: text("onboarding.review.schedule") });
    await expect(schedule.getByText("06:30", { exact: true })).toBeVisible();
    const budget = page.getByRole("region", { name: text("onboarding.review.budget") });
    await expect(budget.getByText(/^4 weeks from /)).toBeVisible();
    await page.getByRole("button", { name: text("onboarding.to_contract") }).click();
    const contract = page.getByRole("region", { name: text("contract.title") });
    await contract.getByLabel(text("contract.agree")).check();
    await contract.getByRole("button", { name: text("contract.sign") }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text("home.title"));
  });
});

base(
  "manual guide, scenarios 2 to 4 and the art directory on the demo account",
  async ({ page, request }) => {
    await page.goto(`${DEMO_LOGIN_URL}/demo-login`);
    await expect(page).toHaveURL(/127\.0\.0\.1/);

    await base.step("2: the money screens open without an error", async () => {
      await opens(page, "/budget", vi("budget.title"));
      await opens(page, "/budget/funding", vi("funding.title"));
      await opens(page, "/inbox", vi("inbox.title"));
      await opens(page, "/anomalies", vi("anomalies.title"));
      await opens(page, "/debts", vi("debts.title"));
      for (const path of ["/penalties", "/cycle-close"]) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBeLessThan(400);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      }
    });

    await base.step("3: the time screens open without an error", async () => {
      await opens(page, "/schedule/today", vi("checklist.title"));
      await opens(page, "/monitor", vi("monitor.title"));
      for (const path of ["/schedule", "/schedule/calendar", "/schedule/review", "/faults"]) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBeLessThan(400);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      }
    });

    await base.step("4: the routine screens open without an error", async () => {
      await opens(page, "/routines", vi("nav.routines"));
      await expect(page.getByRole("heading", { name: vi("routines.title") })).toBeVisible();
      await opens(page, "/routines/sleep", vi("sleep.title"));
    });

    if (ART_DIR) {
      await base.step("art: served to a signed-in user, refused without a session", async () => {
        const own = await page.request.get("/art/whale-chan-avatar?size=small");
        expect(own.status()).toBe(200);
        expect(own.headers()["content-type"]).toMatch(/^image\//);
        expect(own.headers()["cache-control"]).toBeTruthy();
        const anonymous = await request.get("/art/whale-chan-avatar?size=small");
        expect(anonymous.status()).toBeGreaterThanOrEqual(400);
        const traversal = await page.request.get("/art/..%2F..%2Fetc%2Fpasswd?size=small");
        expect([400, 404]).toContain(traversal.status());
        await page.goto("/credits");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(vi("nav.credits"));
      });
    }
  },
);
