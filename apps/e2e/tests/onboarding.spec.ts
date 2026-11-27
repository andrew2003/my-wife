import { text } from "../support/locale";
import { expect, test } from "../support/signed-in";

/**
 * Scenario 1: a freshly invited user signs in, skips the tour, answers the setup
 * questions, reviews the generated sample schedule and budget, and signs the contract.
 * The dev runner seeds the invited user with a pending onboarding (#255).
 */
test("onboarding: sign-in, tour, questions, sample schedule and budget, contract", async ({
  page,
}) => {
  await test.step("the invited user is signed in and sees the product tour", async () => {
    await page.goto("/budget");
    await expect(page.getByRole("link", { name: text("signin.google") })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: text("tour.label") })).toBeVisible();
  });

  await test.step("Skip closes the tour and it stays closed after a reload", async () => {
    const tour = page.getByRole("dialog", { name: text("tour.label") });
    await tour.getByRole("button", { name: text("tour.skip"), exact: true }).click();
    await expect(tour).toBeHidden();
    await page.reload();
    await expect(page.getByRole("navigation", { name: text("nav.label") })).toBeVisible();
    await expect(tour).toHaveCount(0);
  });

  await test.step("the setup questions accept answers", async () => {
    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { level: 1, name: text("onboarding.title") }),
    ).toBeVisible();
    await page.getByLabel(text("onboarding.q.wake")).fill("06:30");
    await page.getByLabel(text("onboarding.q.sleep")).fill("22:30");
    await page.getByLabel(text("onboarding.q.cycle_weeks")).fill("4");
    await page.getByRole("button", { name: text("onboarding.continue") }).click();
  });

  await test.step("the generated sample schedule and sample budget are shown", async () => {
    await expect(page.getByText(text("onboarding.review.intro"))).toBeVisible({ timeout: 30_000 });
    const schedule = page.getByRole("region", { name: text("onboarding.review.schedule") });
    await expect(schedule.getByText(text("schedule.sample.wake"))).toBeVisible();
    await expect(schedule.getByText("06:30", { exact: true })).toBeVisible();
    const budget = page.getByRole("region", { name: text("onboarding.review.budget") });
    await expect(budget.getByText(text("onboarding.review.budget_empty"))).toHaveCount(0);
    await expect(budget.getByRole("listitem").first()).toBeVisible();
    await expect(budget.getByText(/^4 weeks from /)).toBeVisible();
  });

  await test.step("signing the commitment contract completes onboarding", async () => {
    await page.getByRole("button", { name: text("onboarding.to_contract") }).click();
    const contract = page.getByRole("region", { name: text("contract.title") });
    await expect(contract).toBeVisible();
    const sign = contract.getByRole("button", { name: text("contract.sign") });
    await expect(sign).toBeDisabled();
    await contract.getByLabel(text("contract.agree")).check();
    await sign.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text("home.title"));
  });
});
