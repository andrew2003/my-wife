import { expect, test } from "@playwright/test";
import pg from "pg";
import { DATABASE_URL, GATEWAY_URL } from "../support/env";

test("web app, gateway, a service and the database are alive", async ({ page, request }) => {
  await test.step("web app renders from the production build", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome");
  });

  await test.step("fake camera plays the sample video", async () => {
    const size = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const settings = stream.getVideoTracks()[0]!.getSettings();
      stream.getTracks().forEach((t) => t.stop());
      return { width: settings.width, height: settings.height };
    });
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  await test.step("gateway and identity answer health checks", async () => {
    for (const url of [GATEWAY_URL, "http://127.0.0.1:4001"]) {
      const res = await request.get(`${url}/health`);
      expect(res.status()).toBe(200);
      expect((await res.json()).status).toBe("ok");
    }
  });

  await test.step("the per-branch database has one schema per service", async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        "select schema_name from information_schema.schemata where schema_name in ('gateway','identity','budget')",
      );
      expect(rows.map((r) => r.schema_name).sort()).toEqual(["budget", "gateway", "identity"]);
    } finally {
      await client.end();
    }
  });
});
