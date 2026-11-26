import { HeartbeatRequestSchema } from "@my-wife/contracts";
import { expect, test } from "../support/signed-in";

const SESSION_ID = "0190a0a0-0000-7000-8000-000000000001";

test("fake camera: heartbeats only, CPU delegate, no frame leaves the page", async ({ page }) => {
  const heartbeats: Buffer[] = [];
  const others: { type: string; body: Buffer | null }[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.url().includes("/monitor/heartbeat")) {
      heartbeats.push(req.postDataBuffer() ?? Buffer.alloc(0));
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return;
    }
    if (req.method() !== "GET") {
      others.push({ type: req.headers()["content-type"] ?? "", body: req.postDataBuffer() });
    }
    await route.continue();
  });

  await page.goto(`/monitor?sessionId=${SESSION_ID}`);
  await page.getByRole("button").click();
  await expect(page.getByTestId("monitor-status")).toContainText("CPU");
  await expect.poll(() => heartbeats.length, { timeout: 30_000 }).toBeGreaterThan(0);

  for (const body of heartbeats) {
    expect(HeartbeatRequestSchema.safeParse(JSON.parse(body.toString("utf8"))).success).toBe(true);
  }
  for (const request of others) {
    expect(request.type).not.toMatch(/image|octet-stream|multipart|video/);
    expect(request.body?.toString("utf8") ?? "").not.toMatch(/data:image|JFIF/);
  }
});
