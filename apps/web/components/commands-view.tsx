"use client";

import { useState, type FormEvent } from "react";
import type { CustomCommandInput } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import type { BuiltinRow, CommandOverride, CustomForm } from "../lib/commands";
import { ScreenState, stateKeys } from "./screen-state";

const COMMANDS_STATE_KEYS = stateKeys("commands");

export type CommandsStatus = "loading" | "ready" | "error";
/** `saving` while a write runs, `saved` after one, otherwise the refusal code or `failed`. */
export type CommandsNotice = null | "saving" | "saved" | "failed" | "invalid" | string;

export interface CommandsViewProps {
  locale: Locale;
  status: CommandsStatus;
  builtins: BuiltinRow[];
  custom: CustomCommandInput[];
  busy: boolean;
  notice: CommandsNotice;
  onToggleBuiltin: (id: string, enabled: boolean) => void;
  onSaveBuiltin: (
    id: string,
    patch: Pick<CommandOverride, "name" | "aliases" | "description">,
  ) => void;
  onToggleCustom: (command: CustomCommandInput, enabled: boolean) => void;
  onSaveCustom: (previous: CustomCommandInput, form: CustomForm) => void;
  /** Resolves true when the command was created, so the form can be cleared. */
  onAddCustom: (form: CustomForm) => Promise<boolean> | void;
  onDeleteCustom: (name: string) => void;
  onRefresh: () => void;
}

const KINDS = ["prompt", "mood", "shortcut"] as const;

function readForm(form: HTMLFormElement): CustomForm {
  const data = new FormData(form);
  const get = (k: string) => String(data.get(k) ?? "");
  return {
    kind: get("kind"),
    name: get("name"),
    aliases: get("aliases"),
    descVi: get("descVi"),
    descEn: get("descEn"),
    template: get("template"),
    expressionKey: get("expressionKey"),
    targetCommandId: get("targetCommandId"),
    presetArgs: get("presetArgs"),
  };
}

/** Presentational command settings: built-ins to switch and rename, custom commands to manage. */
export function CommandsView(props: CommandsViewProps) {
  const { locale } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  // Which row is being edited: `b:<id>` for a built-in, `c:<name>` for a custom command.
  const [editing, setEditing] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<string>("prompt");

  if (props.status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={COMMANDS_STATE_KEYS} />;
  if (props.status === "error")
    return (
      <ScreenState
        locale={locale}
        kind="error"
        keys={COMMANDS_STATE_KEYS}
        onRetry={props.onRefresh}
      />
    );

  const describe = (id: string, text?: { vi: string; en: string }) =>
    text ? text[locale] : t(`commands.desc.${id}`);

  const notice =
    props.notice === null ? null : props.notice === "saving" ? (
      <p role="status">{t("commands.saving")}</p>
    ) : props.notice === "saved" ? (
      <p role="status">{t("commands.saved")}</p>
    ) : (
      <p role="alert">
        {props.notice === "failed" || props.notice === "invalid"
          ? t(props.notice === "failed" ? "commands.save_failed" : "commands.invalid")
          : translate(locale, `commands.error.${props.notice}`) === `commands.error.${props.notice}`
            ? t("commands.save_failed")
            : t(`commands.error.${props.notice}`)}
      </p>
    );

  const submit = (fn: (form: CustomForm) => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    fn(readForm(e.currentTarget));
  };

  const textFields = (v: { name: string; aliases: string[]; descVi: string; descEn: string }) => (
    <>
      <label>
        {t("commands.field.name")}
        <input name="name" type="text" defaultValue={v.name} required />
      </label>
      <label>
        {t("commands.field.aliases")}
        <input name="aliases" type="text" defaultValue={v.aliases.join(", ")} />
      </label>
      <label>
        {t("commands.field.description_vi")}
        <input name="descVi" type="text" defaultValue={v.descVi} required />
      </label>
      <label>
        {t("commands.field.description_en")}
        <input name="descEn" type="text" defaultValue={v.descEn} required />
      </label>
    </>
  );

  const kindFields = (kind: string, c?: CustomCommandInput) => (
    <>
      {kind === "prompt" ? (
        <label>
          {t("commands.field.template")}
          <textarea
            name="template"
            defaultValue={c?.kind === "prompt" ? c.template : ""}
            required
          />
        </label>
      ) : null}
      {kind === "mood" ? (
        <label>
          {t("commands.field.expression_key")}
          <input
            name="expressionKey"
            type="text"
            defaultValue={c?.kind === "mood" ? c.expressionKey : ""}
            required
          />
        </label>
      ) : null}
      {kind === "shortcut" ? (
        <>
          <label>
            {t("commands.field.target")}
            <input
              name="targetCommandId"
              type="text"
              defaultValue={c?.kind === "shortcut" ? c.targetCommandId : ""}
              required
            />
          </label>
          <label>
            {t("commands.field.preset_args")}
            <input
              name="presetArgs"
              type="text"
              defaultValue={c?.kind === "shortcut" ? c.presetArgs.join(", ") : ""}
            />
          </label>
        </>
      ) : null}
    </>
  );

  const cancel = (
    <button type="button" className="button" onClick={() => setEditing(null)}>
      {t("commands.action.cancel")}
    </button>
  );

  return (
    <section className="commands" aria-label={t("commands.title")}>
      <h2>{t("commands.title")}</h2>
      <p>{t("commands.help")}</p>
      {notice}

      <h3>{t("commands.builtin.title")}</h3>
      <ul>
        {props.builtins.map((b) => (
          <li key={b.id}>
            {editing === `b:${b.id}` ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  const get = (k: string) => String(d.get(k) ?? "").trim();
                  props.onSaveBuiltin(b.id, {
                    name: get("name").replace(/^\//, ""),
                    aliases: get("aliases")
                      .split(",")
                      .map((s) => s.trim().replace(/^\//, ""))
                      .filter((s) => s !== ""),
                    description: { vi: get("descVi"), en: get("descEn") },
                  });
                  setEditing(null);
                }}
              >
                {textFields({
                  name: b.name,
                  aliases: b.aliases,
                  descVi: b.description?.vi ?? translate("vi", `commands.desc.${b.id}`),
                  descEn: b.description?.en ?? translate("en", `commands.desc.${b.id}`),
                })}
                <button type="submit" className="button" disabled={props.busy}>
                  {t("commands.action.save")}
                </button>{" "}
                {cancel}
              </form>
            ) : (
              <>
                <strong>/{b.name}</strong>
                {b.aliases.length > 0 ? (
                  <small>
                    {" "}
                    {t("commands.aliases", { aliases: b.aliases.map((a) => `/${a}`).join(" ") })}
                  </small>
                ) : null}
                <p>{describe(b.id, b.description)}</p>
                <label>
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    disabled={props.busy}
                    onChange={(e) => props.onToggleBuiltin(b.id, e.target.checked)}
                  />{" "}
                  {t("commands.field.enabled")}
                </label>{" "}
                <button type="button" className="button" onClick={() => setEditing(`b:${b.id}`)}>
                  {t("commands.action.edit")}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <h3>{t("commands.custom.title")}</h3>
      {props.custom.length === 0 ? (
        <ScreenState locale={locale} kind="empty" keys={COMMANDS_STATE_KEYS} />
      ) : (
        <ul>
          {props.custom.map((c) => (
            <li key={c.name}>
              {editing === `c:${c.name}` ? (
                <form
                  onSubmit={submit((form) => {
                    props.onSaveCustom(c, form);
                    setEditing(null);
                  })}
                >
                  <input type="hidden" name="kind" value={c.kind} />
                  {textFields({
                    name: c.name,
                    aliases: c.aliases,
                    descVi: c.description.vi,
                    descEn: c.description.en,
                  })}
                  {kindFields(c.kind, c)}
                  <button type="submit" className="button" disabled={props.busy}>
                    {t("commands.action.save")}
                  </button>{" "}
                  {cancel}
                </form>
              ) : (
                <>
                  <strong>/{c.name}</strong> <small>{t(`commands.kind.${c.kind}`)}</small>
                  {c.aliases.length > 0 ? (
                    <small>
                      {" "}
                      {t("commands.aliases", { aliases: c.aliases.map((a) => `/${a}`).join(" ") })}
                    </small>
                  ) : null}
                  <p>{c.description[locale]}</p>
                  <label>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      disabled={props.busy}
                      onChange={(e) => props.onToggleCustom(c, e.target.checked)}
                    />{" "}
                    {t("commands.field.enabled")}
                  </label>{" "}
                  <button
                    type="button"
                    className="button"
                    onClick={() => setEditing(`c:${c.name}`)}
                  >
                    {t("commands.action.edit")}
                  </button>{" "}
                  <button
                    type="button"
                    className="button"
                    disabled={props.busy}
                    onClick={() => props.onDeleteCustom(c.name)}
                  >
                    {t("commands.action.delete")}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>{t("commands.add.title")}</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const target = e.currentTarget;
          void Promise.resolve(props.onAddCustom(readForm(target))).then((ok) => {
            if (ok) target.reset();
          });
        }}
      >
        <label>
          {t("commands.field.kind")}
          <select name="kind" value={addKind} onChange={(e) => setAddKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`commands.kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {textFields({ name: "", aliases: [], descVi: "", descEn: "" })}
        {kindFields(addKind)}
        <button type="submit" className="button" disabled={props.busy}>
          {t("commands.add.submit")}
        </button>
      </form>
    </section>
  );
}
