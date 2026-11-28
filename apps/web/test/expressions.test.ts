import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { ExpressionsView } from "../components/expressions-view";
import { isArtKey } from "../lib/art";
import {
  DEFAULT_EXPRESSION_MAP,
  EXPRESSION_KEYS,
  EXPRESSION_SETS,
  EXPRESSION_STATES,
  defaultExpressionSettings,
  expressionArtKey,
  loadExpressions,
  resolveExpression,
  saveExpressions,
  switchSet,
  type ExpressionSettings,
} from "../lib/expressions";
import { NAV_ITEMS, areaForRoute } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("shared keys", () => {
  it("has the seven keys, three sets and seven states", () => {
    expect([...EXPRESSION_KEYS]).toEqual([
      "greet",
      "joy",
      "love",
      "surprise",
      "ask",
      "sulk",
      "sleep",
    ]);
    expect([...EXPRESSION_SETS]).toEqual(["chibi", "blue_face", "silver_face"]);
    expect(EXPRESSION_STATES).toHaveLength(7);
    expect(defaultExpressionSettings().set).toBe("chibi");
  });

  it.each(EXPRESSION_SETS)("every state resolves to an image in set %s", (set) => {
    const s: ExpressionSettings = { ...defaultExpressionSettings(), set };
    for (const state of EXPRESSION_STATES) {
      const key = resolveExpression(s, state);
      expect(isArtKey(key)).toBe(true);
      expect(key).toBe(expressionArtKey(set, DEFAULT_EXPRESSION_MAP[state]));
    }
  });

  it("resolves every (set, key) pair to a distinct valid art key", () => {
    const all = EXPRESSION_SETS.flatMap((set) =>
      EXPRESSION_KEYS.map((k) => expressionArtKey(set, k)),
    );
    expect(new Set(all).size).toBe(21);
    expect(all.every(isArtKey)).toBe(true);
  });

  it("falls back to the default key when a stored mapping is unknown", () => {
    const s = defaultExpressionSettings();
    const bad = { ...s, map: { ...s.map, task_done: "nope" } } as unknown as ExpressionSettings;
    expect(resolveExpression(bad, "task_done")).toBe(
      expressionArtKey("chibi", DEFAULT_EXPRESSION_MAP.task_done),
    );
  });
});

describe("switching the set keeps the per-state mapping", () => {
  it.each(EXPRESSION_SETS)("keeps a custom mapping when switching to %s", (set) => {
    const base = defaultExpressionSettings();
    const custom: ExpressionSettings = { ...base, map: { ...base.map, task_done: "love" } };
    const next = switchSet(custom, set);
    expect(next.set).toBe(set);
    expect(next.map).toEqual(custom.map);
    expect(resolveExpression(next, "task_done")).toBe(expressionArtKey(set, "love"));
  });

  it("keeps the mapping through save and load", async () => {
    const base = defaultExpressionSettings();
    const custom = switchSet({ ...base, map: { ...base.map, bedtime: "ask" } }, "silver_face");
    const store: Record<string, unknown> = {};
    const fake = async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const b = JSON.parse(String(init.body)) as { key: string; value: unknown };
        store[b.key] = b.value;
        return json(200, { ok: true });
      }
      return json(200, { ok: true, data: { values: store } });
    };
    expect(await saveExpressions(custom, fake)).toBe(true);
    expect(store["appearance.expression_set"]).toBe("silver_face");
    const res = await loadExpressions(fake);
    expect(res).toEqual({ status: "ready", settings: custom });
  });
});

describe("load and save", () => {
  it("uses defaults for missing or malformed values", async () => {
    const res = await loadExpressions(async () =>
      json(200, {
        ok: true,
        data: {
          values: {
            "appearance.expression_set": "weird",
            "appearance.expression_map": { greeting: "joy", bedtime: "bogus" },
          },
        },
      }),
    );
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.settings.set).toBe("chibi");
    expect(res.settings.map.greeting).toBe("joy");
    expect(res.settings.map.bedtime).toBe(DEFAULT_EXPRESSION_MAP.bedtime);
  });

  it("reports an error on failure and false on a failed write", async () => {
    expect((await loadExpressions(async () => json(500, {}))).status).toBe("error");
    expect(
      (
        await loadExpressions(async () => {
          throw new Error("x");
        })
      ).status,
    ).toBe("error");
    expect(await saveExpressions(defaultExpressionSettings(), async () => json(500, {}))).toBe(
      false,
    );
  });
});

describe("expressions view", () => {
  const render = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(ExpressionsView, {
        locale: "en",
        status: "ready",
        settings: defaultExpressionSettings(),
        saveState: "idle",
        artAvailable: false,
        onChange: () => {},
        onSave: () => {},
        onReset: () => {},
        onRefresh: () => {},
        ...over,
      } as never),
    );

  it("lists every state and set with labels from the locale", () => {
    const html = render();
    for (const state of EXPRESSION_STATES)
      expect(html).toContain(en[`expressions.state.${state}` as keyof typeof en]);
    for (const set of EXPRESSION_SETS)
      expect(html).toContain(en[`expressions.set.${set}` as keyof typeof en]);
  });

  it("renders fallback art for each state without a private directory", () => {
    expect(render().match(/fallback-art/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("renders private art urls when available", () => {
    expect(render({ artAvailable: true })).toContain("/art/chibi-greet");
  });

  it("has loading, error and save states", () => {
    expect(render({ status: "loading" })).toContain(en["expressions.loading"]);
    const err = render({ status: "error" });
    expect(err).toContain(en["expressions.error"]);
    expect(err).toContain(en["expressions.retry"]);
    expect(render({ saveState: "saved" })).toContain(en["expressions.saved"]);
    expect(render({ saveState: "failed" })).toContain(en["expressions.save_failed"]);
  });

  it("has the same keys in both locales and a navigation entry", () => {
    const names = (l: Record<string, string>) =>
      Object.keys(l)
        .filter((k) => k.startsWith("expressions."))
        .sort();
    expect(names(vi)).toEqual(names(en));
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/settings/expressions");
    expect(areaForRoute("/settings/expressions")).toBe("more");
    expect(en["nav.expressions"]).toBeDefined();
    expect(vi["nav.expressions"]).toBeDefined();
  });
});
