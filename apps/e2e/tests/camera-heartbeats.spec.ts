import { HeartbeatRequestSchema } from "@my-wife/contracts";
import { expect, test } from "@playwright/test";

const SESSION_ID = "0190a0a0-0000-7000-8000-000000000001";

test("fake camera: heartbeats only, CPU delegate, no frame leaves the page", async ({ page }) => {
  const sent: { type: string; body: Buffer | null }[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      sent.push({ type: req.headers()["content-type"] ?? "", body: req.postDataBuffer() });
    }
    if (req.url().includes("/monitor/heartbeat")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    } else {
      await route.continue();
    }
  });

  await page.goto(`/monitor?sessionId=${SESSION_ID}`);
  await page.getByRole("button").click();
  await expect(page.getByTestId("monitor-status")).toContainText("CPU");
  await expect.poll(() => sent.length, { timeout: 30_000 }).toBeGreaterThan(0);

  for (const request of sent) {
    expect(request.type).not.toMatch(/image|octet-stream|multipart|video/);
    const text = request.body?.toString("utf8") ?? "";
    expect(text).not.toMatch(/data:image|JFIF/);
    expect(HeartbeatRequestSchema.safeParse(JSON.parse(text)).success).toBe(true);
  }
});
