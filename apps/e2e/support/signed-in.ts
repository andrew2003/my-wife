import { readFile } from "node:fs/promises";
import { test as base } from "@playwright/test";
import { SESSION_COOKIE_FILE, WEB_URL } from "./env";

/**
 * Test with a signed-in browser context. The dev runner seeds one session and writes the
 * signed `mw_session` value to a file (#255); the value is never printed.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    const value = (await readFile(SESSION_COOKIE_FILE, "utf8")).trim();
    await context.addCookies([{ name: "mw_session", value, url: WEB_URL, httpOnly: true }]);
    await use(context);
  },
});

export { expect } from "@playwright/test";
