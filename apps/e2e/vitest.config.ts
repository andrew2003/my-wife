import { defineConfig } from "vitest/config";

// The money, time, routines and AI scenarios run under Vitest: Playwright's loader cannot import the services' JSON
// locale files. Playwright ignores this file (see playwright.config.ts).
export default defineConfig({
  test: {
    include: [
      "tests/money.spec.ts",
      "tests/money-extended.spec.ts",
      "tests/time.spec.ts",
      "tests/time-extended.spec.ts",
      "tests/routines.spec.ts",
      "tests/routines-extended.spec.ts",
      "tests/ai-extended.spec.ts",
      "tests/onboarding-extended.spec.ts",
    ],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
