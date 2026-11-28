import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { CommandsView } from "../components/commands-view";
import { NAV_ITEMS } from "../lib/nav";
import {
  BUILTIN_COMMANDS,
  applyOverrides,
  createCustom,
  deleteCustom,
  formToCustomInput,
  loadCommands,
  patchOverride,
  saveOverrides,
  updateCustom,
} from "../lib/commands";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const prompt = {
  kind: "prompt" as const,
  name: "joke",
  aliases: [],
  description: { vi: "Kể chuyện cười", en: "Tell a joke" },
  enabled: true,
  template: "Tell a joke about {text}",
};

describe("loadCommands", () => {
  it("reads custom commands and the stored overrides", async () => {
    const override = { commandId: "help", enabled: false };
    const f = (async (url: string) =>
      url === "/api/ai/commands/custom"
        ? json(200, { ok: true, data: { custom: [prompt] } })
        : json(200, { ok: true, data: { values: { "commands.overrides": [override] } } })) as never;
    const res = await loadCommands(f);
    expect(res).toEqual({ status: "ready", overrides: [override], custom: [prompt] });
  });

  it("falls back to no overrides when the stored value is malformed", async () => {
    const f = (async (url: string) =>
      url === "/api/ai/commands/custom"
        ? json(200, { ok: true, data: { custom: [] } })
        : json(200, { ok: true, data: { values: { "commands.overrides": {} } } })) as never;
    expect(await loadCommands(f)).toEqual({ status: "ready", overrides: [], custom: [] });
  });

  it("reports an error when a read fails", async () => {
    expect((await loadCommands((async () => json(500, {})) as never)).status).toBe("error");
    expect((await loadCommands((async () => Promise.reject(new Error("x"))) as never)).status).toBe(
      "error",
    );
  });
});

describe("built-in rows and overrides", () => {
  it("lists every shipped command with its default alias, on by default", () => {
    const rows = applyOverrides([]);
    expect(rows).toHaveLength(BUILTIN_COMMANDS.length);
    expect(rows.find((r) => r.id === "help")).toMatchObject({
      name: "help",
      aliases: ["tro_giup"],
      enabled: true,
    });
  });

  it("applies a disable, a rename and a description", () => {
    const rows = applyOverrides([
      { commandId: "help", enabled: false },
      { commandId: "task", name: "todo", aliases: ["viec"], description: { vi: "a", en: "b" } },
    ]);
    expect(rows.find((r) => r.id === "help")?.enabled).toBe(false);
    expect(rows.find((r) => r.id === "task")).toMatchObject({
      name: "todo",
      aliases: ["viec"],
      description: { vi: "a", en: "b" },
    });
  });

  it("patchOverride merges into an existing entry and drops an empty one", () => {
    const a = patchOverride([], "help", { enabled: false });
    expect(a).toEqual([{ commandId: "help", enabled: false }]);
    const b = patchOverride(a, "help", { name: "h" });
    expect(b).toEqual([{ commandId: "help", enabled: false, name: "h" }]);
    expect(patchOverride(a, "help", { enabled: undefined })).toEqual([]);
  });

  it("saves the overrides under the settings key", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, JSON.parse(String(init?.body))]);
      return json(200, { ok: true, data: {} });
    }) as never;
    const o = [{ commandId: "help", enabled: false }];
    expect(await saveOverrides(o, f)).toBe(true);
    expect(calls).toEqual([["/api/settings", "PUT", { key: "commands.overrides", value: o }]]);
    expect(await saveOverrides(o, (async () => json(500, {})) as never)).toBe(false);
  });
});

describe("custom command writes", () => {
  it("creates through the gateway and reports a refusal code", async () => {
    const calls: unknown[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, JSON.parse(String(init?.body)).name]);
      return json(201, { ok: true, data: {} });
    }) as never;
    expect(await createCustom(prompt, ok)).toEqual({ ok: true });
    expect(calls).toEqual([["/api/ai/commands/custom", "POST", "joke"]]);
    const refused = (async () => json(422, { ok: false, error: "duplicate_name" })) as never;
    expect(await createCustom(prompt, refused)).toEqual({ ok: false, error: "duplicate_name" });
    expect(await createCustom(prompt, (async () => json(500, {})) as never)).toEqual({
      ok: false,
      error: "failed",
    });
  });

  it("deletes by encoded name", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method]);
      return json(200, { ok: true, data: {} });
    }) as never;
    expect(await deleteCustom("joke", f)).toEqual({ ok: true });
    expect(calls).toEqual([["/api/ai/commands/custom/joke", "DELETE"]]);
  });

  it("edits by replacing, and restores the old command when the new one is refused", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(`${init?.method} ${url} ${body.description?.en ?? ""}`);
      if (init?.method === "POST" && body.description?.en === "New")
        return json(422, { ok: false, error: "too_many_custom" });
      return json(200, { ok: true, data: {} });
    }) as never;
    const next = { ...prompt, description: { vi: "Mới", en: "New" } };
    const res = await updateCustom(prompt, next, f);
    expect(res).toEqual({ ok: false, error: "too_many_custom" });
    expect(calls).toEqual([
      "DELETE /api/ai/commands/custom/joke ",
      "POST /api/ai/commands/custom New",
      "POST /api/ai/commands/custom Tell a joke",
    ]);
    const ok = (async () => json(200, { ok: true, data: {} })) as never;
    expect(await updateCustom(prompt, { ...prompt, enabled: false }, ok)).toEqual({ ok: true });
  });
});

describe("formToCustomInput", () => {
  const base = { name: "joke", aliases: "j, kc", descVi: "Kể", descEn: "Tell" };
  it("builds each kind and splits aliases", () => {
    const p = formToCustomInput({ ...base, kind: "prompt", template: "x {text}" });
    expect(p).toMatchObject({ ok: true, input: { kind: "prompt", aliases: ["j", "kc"] } });
    expect(formToCustomInput({ ...base, kind: "mood", expressionKey: "happy" }).ok).toBe(true);
    const s = formToCustomInput({
      ...base,
      kind: "shortcut",
      targetCommandId: "task",
      presetArgs: "a, b",
    });
    expect(s).toMatchObject({ ok: true, input: { presetArgs: ["a", "b"] } });
  });
  it("refuses a template without {text} and a bad name", () => {
    expect(formToCustomInput({ ...base, kind: "prompt", template: "no placeholder" }).ok).toBe(
      false,
    );
    expect(
      formToCustomInput({ ...base, name: "Bad Name", kind: "prompt", template: "{text}" }).ok,
    ).toBe(false);
  });
});

const view = {
  locale: "en",
  status: "ready",
  builtins: applyOverrides([{ commandId: "help", enabled: false }]),
  custom: [prompt],
  busy: false,
  notice: null,
  onToggleBuiltin: () => {},
  onSaveBuiltin: () => {},
  onToggleCustom: () => {},
  onSaveCustom: () => {},
  onAddCustom: () => {},
  onDeleteCustom: () => {},
  onRefresh: () => {},
};
const render = (p: object) =>
  renderToStaticMarkup(createElement(CommandsView, { ...view, ...p } as never));

describe("CommandsView", () => {
  it("lists built-ins with locale descriptions and custom commands", () => {
    const html = render({});
    expect(html).toContain(en["commands.title"]);
    expect(html).toContain("/help");
    expect(html).toContain(en["commands.desc.help"]);
    expect(html).toContain("/joke");
    expect(html).toContain("Tell a joke");
    expect(render({ locale: "vi" })).toContain(vi["commands.desc.help"]);
    expect(render({ locale: "vi" })).toContain("Kể chuyện cười");
  });

  it("offers an add form, edit, enable and delete actions", () => {
    const html = render({});
    expect(html).toContain(en["commands.add.submit"]);
    expect(html).toContain(en["commands.action.edit"]);
    expect(html).toContain(en["commands.action.delete"]);
    expect(html).toContain(en["commands.field.enabled"]);
  });

  it("has loading, empty custom list, error and notice states", () => {
    expect(render({ status: "loading" })).toContain(en["commands.loading"]);
    const err = render({ status: "error" });
    expect(err).toContain(en["commands.error"]);
    expect(err).toContain(en["commands.retry"]);
    expect(render({ custom: [] })).toContain(en["commands.empty"]);
    expect(render({ notice: "saved" })).toContain(en["commands.saved"]);
    expect(render({ notice: "duplicate_name" })).toContain(en["commands.error.duplicate_name"]);
    expect(render({ notice: "failed" })).toContain(en["commands.save_failed"]);
  });

  it("has the same commands keys in vi and en, and a navigation entry", () => {
    const names = (l: Record<string, string>) =>
      Object.keys(l)
        .filter((k) => k.startsWith("commands.") || k === "nav.commands")
        .sort();
    expect(names(vi)).toEqual(names(en));
    expect(names(en).length).toBeGreaterThan(30);
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/settings/commands");
  });

  it("has a description for every built-in in both locales", () => {
    for (const b of BUILTIN_COMMANDS) {
      expect((en as Record<string, string>)[`commands.desc.${b.id}`]).toBeTruthy();
      expect((vi as Record<string, string>)[`commands.desc.${b.id}`]).toBeTruthy();
    }
  });
});
