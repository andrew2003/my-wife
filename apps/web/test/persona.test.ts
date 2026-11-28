import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { PersonaView } from "../components/persona-view";
import { translate } from "../lib/i18n";
import { NAV_ITEMS } from "../lib/nav";
import {
  PERSONA_KEYS,
  defaultPersonaSettings,
  loadPersona,
  resolveTerms,
  savePersona,
  tp,
  type PersonaSettings,
} from "../lib/persona";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("defaults come from the locale files", () => {
  it("builds enabled defaults and disabled offered terms per locale", () => {
    const d = defaultPersonaSettings();
    expect(d.address_user.en.filter((t) => t.enabled).map((t) => t.text)).toEqual(
      en["persona.default.address_user"].split("|"),
    );
    expect(d.address_user.en.filter((t) => !t.enabled).map((t) => t.text)).toEqual(
      en["persona.offered.address_user"].split("|"),
    );
    expect(d.wife_label.vi.some((t) => t.enabled)).toBe(true);
  });
});

describe("resolveTerms and tp (table-driven)", () => {
  const custom: PersonaSettings = {
    address_user: {
      vi: [{ text: "cậu chủ", enabled: true }],
      en: [{ text: "boss", enabled: true }],
    },
    self_reference: { vi: [{ text: "tớ", enabled: true }], en: [{ text: "me", enabled: true }] },
    wife_label: { vi: [{ text: "bé", enabled: false }], en: [{ text: "bae", enabled: true }] },
  };
  const rows: Array<["vi" | "en", string, string, string]> = [
    ["en", "boss", "me", "bae"],
    ["vi", "cậu chủ", "tớ", vi["persona.neutral.wife_label"]],
  ];
  it.each(rows)("honours a custom term and a switched-off term in %s", (locale, a, s, w) => {
    expect(resolveTerms(custom, locale)).toEqual({ addressUser: a, self: s, wifeLabel: w });
  });

  it("honours a removed default: a deleted term is never used", () => {
    const d = defaultPersonaSettings();
    const removed = d.address_user.en[0]!.text;
    const next = { ...d, address_user: { ...d.address_user, en: d.address_user.en.slice(1) } };
    for (let i = 0; i < 6; i++) {
      expect(resolveTerms(next, "en", i).addressUser).not.toBe(removed);
    }
  });

  it("rotates through the enabled terms by index", () => {
    const d = defaultPersonaSettings();
    const enabled = d.address_user.en.filter((t) => t.enabled);
    expect(resolveTerms(d, "en", 1).addressUser).toBe(enabled[1]!.text);
    expect(resolveTerms(d, "en", enabled.length).addressUser).toBe(enabled[0]!.text);
  });

  it("falls back to neutral locale words when nothing is enabled", () => {
    const empty: PersonaSettings = {
      address_user: { vi: [], en: [] },
      self_reference: { vi: [], en: [] },
      wife_label: { vi: [], en: [] },
    };
    expect(resolveTerms(empty, "en").addressUser).toBe(en["persona.neutral.address_user"]);
  });

  it("fills placeholders from the locale catalog text", () => {
    for (const locale of ["vi", "en"] as const) {
      const out = tp(locale, "persona.sample.greeting", resolveTerms(custom, locale));
      expect(out).not.toMatch(/\{\w+\}/);
    }
    expect(tp("en", "persona.sample.greeting", resolveTerms(custom, "en"))).toContain("boss");
    expect(translate("en", "persona.sample.greeting")).toContain("{addressUser}");
  });
});

describe("loadPersona and savePersona", () => {
  it("reads stored values and falls back to defaults", async () => {
    const stored = { vi: [{ text: "x", enabled: true }], en: [] };
    const res = await loadPersona((async () =>
      json(200, { ok: true, data: { values: { "persona.address_user": stored } } })) as never);
    expect(res.status).toBe("ready");
    if (res.status === "ready") {
      expect(res.settings.address_user).toEqual(stored);
      expect(res.settings.self_reference).toEqual(defaultPersonaSettings().self_reference);
    }
    expect((await loadPersona((async () => json(500, {})) as never)).status).toBe("error");
    const bad = await loadPersona((async () =>
      json(200, { ok: true, data: { values: { "persona.wife_label": 5 } } })) as never);
    expect(bad.status).toBe("ready");
  });

  it("saves each list under its settings key", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, JSON.parse(String(init?.body)).key]);
      return json(200, { ok: true, data: {} });
    }) as never;
    expect(await savePersona(defaultPersonaSettings(), f)).toBe(true);
    expect(calls).toEqual(PERSONA_KEYS.map((k) => ["/api/settings", "PUT", k.key]));
    expect(await savePersona(defaultPersonaSettings(), (async () => json(500, {})) as never)).toBe(
      false,
    );
  });
});

const base = {
  locale: "en",
  status: "ready",
  settings: defaultPersonaSettings(),
  saveState: "idle",
  onChange: () => {},
  onSave: () => {},
  onReset: () => {},
  onRefresh: () => {},
};
const render = (p: object) =>
  renderToStaticMarkup(createElement(PersonaView, { ...base, ...p } as never));

describe("PersonaView", () => {
  it("lists terms of the active locale with locale-file labels and placeholders", () => {
    const html = render({});
    expect(html).toContain(en["persona.title"]);
    expect(html).toContain(en["persona.list.address_user"]);
    expect(html).toContain("honey");
    expect(html).toContain(`placeholder="${en["persona.add.placeholder"]}"`);
    const viHtml = render({ locale: "vi" });
    expect(viHtml).toContain(`placeholder="${vi["persona.add.placeholder"]}"`);
    expect(viHtml).toContain("anh yêu");
    expect(viHtml).not.toContain("honey");
  });

  it("shows a custom term and hides a removed default", () => {
    const d = defaultPersonaSettings();
    const settings = {
      ...d,
      address_user: { ...d.address_user, en: [{ text: "captain", enabled: true }] },
    };
    const html = render({ settings });
    expect(html).toContain("captain");
    expect(html).not.toContain('value="darling"');
  });

  it("previews with the chosen terms", () => {
    expect(render({})).toContain(en["persona.preview.title"]);
  });

  it("has loading, error and saved states", () => {
    expect(render({ status: "loading" })).toContain(en["persona.loading"]);
    const err = render({ status: "error" });
    expect(err).toContain(en["persona.error"]);
    expect(err).toContain(en["persona.retry"]);
    expect(render({ saveState: "saved" })).toContain(en["persona.saved"]);
    expect(render({ saveState: "failed" })).toContain(en["persona.save_failed"]);
  });

  it("has the same persona keys in vi and en and a navigation entry", () => {
    const names = (l: Record<string, string>) =>
      Object.keys(l)
        .filter((k) => k.startsWith("persona."))
        .sort();
    expect(names(vi)).toEqual(names(en));
    expect(names(en).length).toBeGreaterThan(15);
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/settings/persona");
    expect(en["nav.persona"]).toBeDefined();
    expect(vi["nav.persona"]).toBeDefined();
  });
});
