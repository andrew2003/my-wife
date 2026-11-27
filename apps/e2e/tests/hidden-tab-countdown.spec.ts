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
  /**
   * Displayed seconds minus the seconds left on the server end time, both read in one
   * evaluation so no time passes between them.
   */
  const drift = () =>
    page.evaluate(
      ({ endMs, label }) => {
        const el = document.querySelector(`[role="timer"][aria-label="${label}"]`);
        const parts = (el?.textContent ?? "").trim().split(":").map(Number);
        const shown = parts.reduce((total, part) => total * 60 + part, 0);
        return shown - Math.ceil((endMs - Date.now()) / 1000);
      },
      { endMs: plannedEndMs, label: text("countdown.label") },
    );

  // A background tab loses timer ticks. Headless Chromium throttles nothing, so the page is
  // given a switch that swallows every tick (worker messages and page intervals) while on.
  // A display that counted ticks would fall behind by every swallowed tick; one that is
  // computed from the stored end time catches up on the next tick.
  await page.addInitScript(() => {
    const w = window as unknown as { __stallTicks: boolean };
    w.__stallTicks = false;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      set onmessage(handler: ((e: MessageEvent) => unknown) | null) {
        super.onmessage = handler
          ? (e: MessageEvent) => {
              if (!w.__stallTicks) handler.call(this, e);
            }
          : null;
      }
    } as typeof Worker;
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
      nativeSetInterval(
        typeof fn === "function"
          ? (...a: unknown[]) => {
              if (!w.__stallTicks) fn(...a);
            }
          : fn,
        ms,
        ...args,
      )) as typeof setInterval;
  });
  const stallTicks = (on: boolean) =>
    page.evaluate((v) => {
      (window as unknown as { __stallTicks: boolean }).__stallTicks = v;
    }, on);
  const hide = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, "visibilityState", {
        value: h ? "hidden" : "visible",
        configurable: true,
      });
      Object.defineProperty(document, "hidden", { value: h, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);

  await test.step("the visible countdown matches the server end time", async () => {
    await page.goto("/schedule/today");
    await expect(timer()).toBeVisible({ timeout: 30_000 });
    expect(Math.abs(await drift())).toBeLessThanOrEqual(ONE_SECOND);
  });

  await test.step("a hidden tab stays within one second, also after lost ticks", async () => {
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    // Headless Chromium keeps every page visible, so hide this one the way the browser does:
    // the document reports `hidden` and fires `visibilitychange`.
    await hide(true);
    expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
    const before = seconds(await timer().innerText());
    const samples: number[] = [];
    // Ten seconds, one sample per second. Seconds 3 to 6 lose every tick; the samples taken
    // from second 7 on have had a tick since, so they must be right again.
    for (let second = 1; second <= 10; second += 1) {
      await stallTicks(second >= 3 && second <= 6);
      // Real time must pass: the countdown under test follows the wall clock, nothing to poll for.
      await page.waitForTimeout(1000);
      if (second < 3 || second >= 8) samples.push(await drift());
    }
    await stallTicks(false);
    expect(samples).toHaveLength(5);
    for (const d of samples) expect(Math.abs(d)).toBeLessThanOrEqual(ONE_SECOND);
    expect(before - seconds(await timer().innerText())).toBeGreaterThanOrEqual(9);
  });

  await test.step("showing the tab again refreshes the display at once", async () => {
    await hide(false);
    expect(Math.abs(await drift())).toBeLessThanOrEqual(ONE_SECOND);
  });
});
