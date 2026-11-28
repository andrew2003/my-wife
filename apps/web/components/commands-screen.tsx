"use client";

import { useCallback, useEffect, useState } from "react";
import type { CustomCommandInput } from "@my-wife/contracts";
import type { Locale } from "../lib/i18n";
import {
  applyOverrides,
  createCustom,
  deleteCustom,
  formToCustomInput,
  loadCommands,
  patchOverride,
  saveOverrides,
  updateCustom,
  type CommandOverride,
  type CustomForm,
  type WriteResult,
} from "../lib/commands";
import { CommandsView, type CommandsNotice, type CommandsStatus } from "./commands-view";

/** Loads the command list and persists every change at once, so the list always matches the server. */
export function CommandsScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<CommandsStatus>("loading");
  const [overrides, setOverrides] = useState<CommandOverride[]>([]);
  const [custom, setCustom] = useState<CustomCommandInput[]>([]);
  const [notice, setNotice] = useState<CommandsNotice>(null);

  const load = useCallback(async () => {
    const res = await loadCommands();
    if (res.status === "ready") {
      setOverrides(res.overrides);
      setCustom(res.custom);
    }
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveBuiltins = async (next: CommandOverride[]) => {
    setNotice("saving");
    if (await saveOverrides(next)) {
      setOverrides(next);
      setNotice("saved");
    } else {
      setNotice("failed");
    }
  };

  /** Runs a custom-command write, then re-reads the list so it shows what the server kept. */
  const writeCustom = async (run: () => Promise<WriteResult>): Promise<boolean> => {
    setNotice("saving");
    const result = await run();
    await load();
    setNotice(result.ok ? "saved" : result.error);
    return result.ok;
  };

  const saveCustom = (previous: CustomCommandInput, form: CustomForm) => {
    const next = formToCustomInput(form, previous.enabled);
    if (!next.ok) return setNotice("invalid");
    void writeCustom(() => updateCustom(previous, next.input));
  };

  return (
    <CommandsView
      locale={locale}
      status={status}
      builtins={applyOverrides(overrides)}
      custom={custom}
      busy={notice === "saving"}
      notice={notice}
      onToggleBuiltin={(id, enabled) =>
        void saveBuiltins(patchOverride(overrides, id, { enabled: enabled ? undefined : false }))
      }
      onSaveBuiltin={(id, patch) => void saveBuiltins(patchOverride(overrides, id, patch))}
      onToggleCustom={(c, enabled) => void writeCustom(() => updateCustom(c, { ...c, enabled }))}
      onSaveCustom={saveCustom}
      onAddCustom={async (form) => {
        const next = formToCustomInput(form);
        if (!next.ok) {
          setNotice("invalid");
          return false;
        }
        return writeCustom(() => createCustom(next.input));
      }}
      onDeleteCustom={(name) => void writeCustom(() => deleteCustom(name))}
      onRefresh={() => {
        setStatus("loading");
        void load();
      }}
    />
  );
}
