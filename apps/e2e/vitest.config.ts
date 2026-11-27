import { defineConfig } from "vitest/config";

// The money and time scenarios run under Vitest: Playwright's loader cannot import the services' JSON
// locale files. Playwright ignores this file (see playwright.config.ts).
export default defineConfig({
  test: {
    include: ["tests/money.spec.ts", "tests/time.spec.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
