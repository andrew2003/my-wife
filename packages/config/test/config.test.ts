import { describe, expect, it } from "vitest";
import { loadConfig, servicePort } from "../src/index";

const base = { SESSION_SECRET: "x".repeat(32) };

describe("loadConfig", () => {
  it("defaults the UI language to Vietnamese and login to google", () => {
    const c = loadConfig(base);
    expect(c.uiLanguage).toBe("vi");
    expect(c.loginMethod).toBe("google");
  });

  it("reads UI_LANGUAGE and LOGIN_METHOD", () => {
    const c = loadConfig({ ...base, UI_LANGUAGE: "en", LOGIN_METHOD: "magic_link" });
    expect(c.uiLanguage).toBe("en");
    expect(c.loginMethod).toBe("magic_link");
  });

  it("rejects an unknown login method", () => {
    expect(() => loadConfig({ ...base, LOGIN_METHOD: "password" })).toThrow();
  });

  it("rejects a short session secret", () => {
    expect(() => loadConfig({ SESSION_SECRET: "short" })).toThrow();
  });

  it("keeps the NATS subject prefix empty by default", () => {
    expect(loadConfig(base).natsSubjectPrefix).toBe("");
  });
});

describe("servicePort", () => {
  it("gives every service a distinct port", () => {
    const names = [
      "gateway",
      "identity",
      "budget",
      "ingest",
      "schedule",
      "monitor",
      "rules",
      "ai",
      "notify",
      "sync",
    ] as const;
    const ports = names.map((n) => servicePort(n));
    expect(new Set(ports).size).toBe(names.length);
  });
});
