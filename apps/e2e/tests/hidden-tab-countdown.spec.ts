import { text } from "../support/locale";
import { WEB_URL } from "../support/env";
import { expect, test } from "../support/signed-in";

/**
 * Scenario 3, browser part: the countdown of a running work session keeps true time while its
 * tab is in the background. The session runs on the server clock; the page only displays the
 * remaining time computed from the stored end time (never by counting ticks), so a throttled
 * tab cannot drift, and the display is refreshed the moment the tab is shown again.
 */
const ONE_SECOND = 1;

/** Parses "mm:ss" or "h:mm:ss" into seconds. */
function seconds(display: string): number {
  return display
    .trim()
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

test("the countdown of a hidden tab stays within one second of the server clock", async ({
  page,
  context,
}) => {
  let plannedEndMs = 0;

  await test.step("a task is planned for today and its session is started", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const created = await context.request.post(`${WEB_URL}/api/tasks`, {
      data: { title: "Hidden tab task", day: today, kind: "desk", monitoringProfile: "none" },
    });
    expect(created.status()).toBe(200);
    const taskId = (await created.json()).data.task.id as string;
    const started = await context.request.post(`${WEB_URL}/api/sessions/start`, {
      data: { taskId, durationMinutes: 5 },
    });
    expect(started.status()).toBe(200);
    plannedEndMs = Date.parse((await started.json()).data.session.plannedEndAt);
  });

  const timer = () => page.getByRole("timer", { name: text("countdown.label") });
  /** Displayed seconds minus the seconds left on the server end time, read at the same moment. */
  const drift = async () => {
    const shown = seconds(await timer().innerText());
    return shown - Math.ceil((plannedEndMs - Date.now()) / 1000);
  };

  await test.step("the visible countdown matches the server end time", async () => {
    await page.goto("/schedule/today");
    await expect(timer()).toBeVisible({ timeout: 30_000 });
    expect(Math.abs(await drift())).toBeLessThanOrEqual(ONE_SECOND);
  });

  await test.step("the tab goes to the background and keeps counting", async () => {
    const before = seconds(await timer().innerText());
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    // Headless Chromium keeps every page visible, so hide this one the way the browser does:
    // the document reports `hidden` and fires `visibilitychange`.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
    await expect
      .poll(async () => before - seconds(await timer().innerText()), {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(5);
    expect(Math.abs(await drift())).toBeLessThanOrEqual(ONE_SECOND);
  });

  await test.step("showing the tab again refreshes the display at once", async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(Math.abs(await drift())).toBeLessThanOrEqual(ONE_SECOND);
  });
});
