import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp, createMemoryStore, type IdentityDeps } from "../src/index";

const USER = { "x-user-id": "u1" };

function setup(deps: IdentityDeps = {}) {
  const config = loadConfig({
    SESSION_SECRET: "s".repeat(32),
    LOG_LEVEL: "silent",
    SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  return createApp(config, { store: createMemoryStore(), ...deps });
}
type App = ReturnType<typeof setup>;

const checklist = async (app: App, headers: Record<string, string> = USER) =>
  app.inject({ method: "GET", url: "/onboarding/checklist", headers });
const item = async (app: App, step: string) =>
  (await checklist(app)).json().data.items.find((i: { step: string }) => i.step === step);
const recordStep = (app: App, step: string, skipped: boolean) =>
  app.inject({
    method: "POST",
    url: "/onboarding/steps",
    headers: USER,
    payload: { step, skipped },
  });

describe("setup checklist", () => {
  it("requires a verified user id", async () => {
    expect((await checklist(setup(), {})).statusCode).toBe(401);
  });

  it("lists every setup step as pending for a new user", async () => {
    const res = await checklist(setup());
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as { step: string; status: string }[];
    expect(items.map((i) => i.step)).toEqual([
      "connect_channel",
      "llm_key",
      "mail_forwarding",
      "notifications_camera_install",
      "do_not_disturb",
    ]);
    expect(items.every((i) => i.status === "pending")).toBe(true);
  });

  it("marks connect_channel done only when the channel check passes", async () => {
    let linked = false;
    const app = setup({ checks: { channelLinked: async () => linked } });
    expect(await item(app, "connect_channel")).toMatchObject({ status: "pending", checked: true });
    linked = true;
    expect(await item(app, "connect_channel")).toMatchObject({ status: "done", checked: true });
  });

  it("reports an unwired check as pending and not checked", async () => {
    expect(await item(setup(), "mail_forwarding")).toMatchObject({
      status: "pending",
      checked: false,
    });
  });

  it("marks mail_forwarding done when forwarding is verified", async () => {
    const app = setup({ checks: { forwardingVerified: async (id) => id === "u1" } });
    expect((await item(app, "mail_forwarding")).status).toBe("done");
  });

  it("treats a failing check as pending, not as done", async () => {
    const app = setup({
      checks: {
        channelLinked: async () => {
          throw new Error("down");
        },
      },
    });
    expect(await item(app, "connect_channel")).toMatchObject({ status: "pending", checked: false });
  });

  it("marks llm_key done once a key is stored, and pending after it is deleted", async () => {
    const app = setup();
    await app.inject({
      method: "PUT",
      url: "/secrets/llm_key",
      headers: USER,
      payload: { value: "sk-test" },
    });
    expect((await item(app, "llm_key")).status).toBe("done");
    await app.inject({ method: "DELETE", url: "/secrets/llm_key", headers: USER });
    expect((await item(app, "llm_key")).status).toBe("pending");
  });

  it("marks notifications_camera_install done while the camera consent is granted", async () => {
    const app = setup();
    await app.inject({
      method: "POST",
      url: "/consents",
      headers: USER,
      payload: { kind: "camera", textVersion: 1 },
    });
    expect((await item(app, "notifications_camera_install")).status).toBe("done");
    await app.inject({ method: "DELETE", url: "/consents/camera", headers: USER });
    expect((await item(app, "notifications_camera_install")).status).toBe("pending");
  });

  it("uses the recorded step for a browser-only item", async () => {
    const app = setup();
    await recordStep(app, "do_not_disturb", false);
    expect(await item(app, "do_not_disturb")).toMatchObject({ status: "done", checked: false });
  });

  it("shows a skipped step as skipped, but a passed real check wins over a skip", async () => {
    const app = setup({ checks: { channelLinked: async () => true } });
    await recordStep(app, "connect_channel", true);
    await recordStep(app, "llm_key", true);
    expect((await item(app, "llm_key")).status).toBe("skipped");
    expect((await item(app, "connect_channel")).status).toBe("done");
  });

  it("does not show another user's state", async () => {
    const app = setup();
    await app.inject({
      method: "PUT",
      url: "/secrets/llm_key",
      headers: USER,
      payload: { value: "sk-test" },
    });
    const other = await checklist(app, { "x-user-id": "u2" });
    expect(other.json().data.items.find((i: { step: string }) => i.step === "llm_key").status).toBe(
      "pending",
    );
  });
});
