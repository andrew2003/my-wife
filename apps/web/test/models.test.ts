import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { ModelsView } from "../components/models-view";
import { NAV_ITEMS } from "../lib/nav";
import { loadKeys, maskKey, removeKey, switchModel } from "../lib/models";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const key = {
  provider: "anthropic",
  model: "m-1",
  keyId: "key-abcdef123456",
  valid: true,
  role: "primary",
};

describe("loadKeys", () => {
  it("reads key views and reports empty and error states", async () => {
    const ok = await loadKeys((async () =>
      json(200, { ok: true, data: { keys: [key] } })) as never);
    expect(ok).toEqual({ status: "ready", keys: [key] });
    const none = await loadKeys((async () =>
      json(200, { ok: true, data: { keys: [] } })) as never);
    expect(none).toEqual({ status: "empty" });
    expect((await loadKeys((async () => json(500, {})) as never)).status).toBe("error");
  });
});

describe("maskKey", () => {
  it("never reveals more than a fixed mask", () => {
    expect(maskKey()).toBe("••••••••");
  });
});

describe("switchModel", () => {
  const input = {
    provider: "openai",
    model: "m-2",
    role: "primary",
    apiKey: "sk-secret-value",
  } as const;

  it("posts to the switch route and returns the handover result", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, JSON.parse(String(init?.body))]);
      return json(200, {
        ok: true,
        data: { modelRole: "primary", state: "failed", passRatio: 0.5, failedQuestions: ["q1"] },
      });
    }) as never;
    const res = await switchModel(input, f);
    expect(res).toEqual({
      status: "done",
      result: { modelRole: "primary", state: "failed", passRatio: 0.5, failedQuestions: ["q1"] },
    });
    expect(calls).toEqual([["/api/models/switch", "POST", input]]);
  });

  it("maps refusal codes and never echoes the key", async () => {
    const res = await switchModel(input, (async () =>
      json(422, { ok: false, error: "key_invalid" })) as never);
    expect(res).toEqual({ status: "refused", reason: "key_invalid" });
    expect(JSON.stringify(res)).not.toContain("sk-secret-value");
    const unavailable = await switchModel(input, (async () =>
      json(503, { ok: false, error: "x" })) as never);
    expect(unavailable.status).toBe("error");
    const thrown = await switchModel(input, (async () => {
      throw new Error("sk-secret-value");
    }) as never);
    expect(thrown).toEqual({ status: "error" });
  });
});

describe("removeKey", () => {
  it("deletes by key id", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method]);
      return json(200, { ok: true, data: {} });
    }) as never;
    expect(await removeKey("key-1", f)).toBe(true);
    expect(calls).toEqual([["/api/keys/key-1", "DELETE"]]);
  });
});

const base = {
  locale: "en",
  status: "ready",
  keys: [key],
  switchState: "idle",
  handover: null,
  onSwitch: () => {},
  onRemove: () => {},
  onRefresh: () => {},
};
const render = (p: object) =>
  renderToStaticMarkup(createElement(ModelsView, { ...base, ...p } as never));

describe("ModelsView", () => {
  it("shows models and masked keys without the key id", () => {
    const html = render({});
    expect(html).toContain("m-1");
    expect(html).toContain("••••");
    expect(html).toContain(en["models.role.primary"]);
    expect(html).not.toContain("key-abcdef123456");
  });

  it("reports a passed and a failed handover", () => {
    const passed = render({
      handover: { modelRole: "primary", state: "passed", passRatio: 0.9, failedQuestions: [] },
    });
    expect(passed).toContain("90%");
    expect(passed).toContain(en["models.handover.passed"].slice(0, 10));
    const failed = render({
      handover: {
        modelRole: "primary",
        state: "failed",
        passRatio: 0.5,
        failedQuestions: ["How much food budget is left?"],
      },
    });
    expect(failed).toContain("How much food budget is left?");
    expect(failed).toContain(en["models.handover.failed"].slice(0, 10));
  });

  it("has loading, empty (with the form) and error states", () => {
    expect(render({ status: "loading", keys: [] })).toContain(en["models.loading"]);
    const empty = render({ status: "empty", keys: [] });
    expect(empty).toContain(en["models.empty"]);
    expect(empty).toContain('type="password"');
    const err = render({ status: "error", keys: [] });
    expect(err).toContain(en["models.error"]);
    expect(err).toContain(en["models.retry"]);
  });

  it("has the same locale keys in vi and en and a navigation entry", () => {
    const names = (l: Record<string, string>) =>
      Object.keys(l)
        .filter((k) => k.startsWith("models."))
        .sort();
    expect(names(vi)).toEqual(names(en));
    expect(names(en).length).toBeGreaterThan(10);
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/settings/models");
  });
});
