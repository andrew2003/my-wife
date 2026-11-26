import { defineConfig, devices } from "@playwright/test";
import {
  CAMERA_DELEGATE,
  DATABASE_URL,
  FAKE_VIDEO,
  NATS_SUBJECT_PREFIX,
  WEB_PORT,
  WEB_URL,
} from "./support/env";

const root = new URL("../..", import.meta.url).pathname;

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    headless: true,
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${FAKE_VIDEO}`,
        "--disable-gpu",
      ],
    },
    permissions: ["camera"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // All ten services in one Node process (ADR 0007); gateway listens on 4000.
      command: "pnpm --filter @my-wife/dev-runner start",
      cwd: root,
      url: "http://127.0.0.1:4000/health",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL,
        NATS_SUBJECT_PREFIX,
        LOG_LEVEL: "warn",
        SESSION_SECRET: "e2e-only-secret-e2e-only-secret-0000",
      },
    },
    {
      // Production build, built by scripts/run.mjs before the run.
      command: "pnpm --filter @my-wife/web start",
      cwd: root,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(WEB_PORT),
        HOSTNAME: "127.0.0.1",
        UI_LANGUAGE: "en",
        CAMERA_ANALYSIS_DELEGATE: CAMERA_DELEGATE,
        GATEWAY_URL: "http://127.0.0.1:4000",
      },
    },
  ],
});
