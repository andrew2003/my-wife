import { translate, type Locale } from "../lib/i18n";
import {
  BUDGET_SHEET_TABS,
  isVndField,
  type BudgetSheet,
  type BudgetSheetRow,
  type BudgetSheetTab,
} from "../lib/budget-sheet";
import { ScreenState, stateKeys } from "./screen-state";

const STATE_KEYS = stateKeys("budgetsheet");

export type BudgetSheetStatus = "loading" | "ready" | "empty" | "error";

export interface BudgetSheetViewProps {
  locale: Locale;
  status: BudgetSheetStatus;
  sheet: BudgetSheet | null;
  tab: BudgetSheetTab;
  /** `entityId:field` of the cell being saved. */
  busyCell: string | null;
  errorKey: string | null;
  onTab: (tab: BudgetSheetTab) => void;
  onSave: (entityId: string, field: string, text: string) => void;
  onRetry: () => void;
}

/** Rows with the same fields share one table; the ledger mixes two kinds of row. */
function groupRows(rows: BudgetSheetRow[]): BudgetSheetRow[][] {
  const groups: BudgetSheetRow[][] = [];
  let signature = "";
  for (const row of rows) {
    const next = row.cells.map((c) => c.field).join("|");
    if (next !== signature) groups.push([]);
    signature = next;
    groups[groups.length - 1]!.push(row);
  }
  return groups;
}

/** Presentational budget sheet: plan cells are inputs, every other cell is locked text. */
export function BudgetSheetView(props: BudgetSheetViewProps) {
  const { locale, status, sheet, tab, busyCell, errorKey } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  if (status === "loading") return <ScreenState locale={locale} kind="loading" keys={STATE_KEYS} />;
  if (status === "empty") return <ScreenState locale={locale} kind="empty" keys={STATE_KEYS} />;
  if (status === "error" || !sheet) {
    return <ScreenState locale={locale} kind="error" keys={STATE_KEYS} onRetry={props.onRetry} />;
  }

  const rows = sheet.tabs[tab] ?? [];
  const show = (field: string, value: string | number | boolean | null): string => {
    if (value === null) return "";
    if (typeof value === "boolean") return t(value ? "budgetsheet.yes" : "budgetsheet.no");
    return typeof value === "number" && isVndField(field)
      ? value.toLocaleString(locale === "vi" ? "vi-VN" : "en-US")
      : String(value);
  };

  return (
    <div>
      <p>{t("budgetsheet.cycle_of", { date: sheet.cycle.firstDay })}</p>
      {sheet.readOnly ? <p role="status">{t("budgetsheet.read_only")}</p> : null}
      {errorKey ? <p role="alert">{t(errorKey)}</p> : null}
      <p>{t("budgetsheet.legend")}</p>
      <div role="tablist" style={{ display: "flex", gap: 8, overflowX: "auto" }}>
        {BUDGET_SHEET_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === tab}
            onClick={() => props.onTab(name)}
          >
            {t(`budgetsheet.tab.${name}`)}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <p>{t("budgetsheet.tab_empty")}</p> : null}
      {groupRows(rows).map((group) => (
        <div key={group[0]!.entityId} style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                {group[0]!.cells.map((c) => (
                  <th key={c.field} scope="col">
                    {t(`budgetsheet.col.${c.field}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.map((row) => (
                <tr key={row.entityId}>
                  {row.cells.map((cell) => {
                    const text = cell.value === null ? "" : String(cell.value);
                    if (!cell.editable) {
                      return (
                        <td key={cell.field} data-locked="true">
                          <span title={t("budgetsheet.locked")}>
                            {show(cell.field, cell.value)}
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={cell.field}>
                        <input
                          aria-label={t(`budgetsheet.col.${cell.field}`)}
                          type={isVndField(cell.field) ? "number" : "text"}
                          min={isVndField(cell.field) ? 0 : undefined}
                          step={isVndField(cell.field) ? 1 : undefined}
                          defaultValue={text}
                          disabled={busyCell === `${row.entityId}:${cell.field}`}
                          onBlur={(e) => {
                            if (e.currentTarget.value !== text)
                              props.onSave(row.entityId, cell.field, e.currentTarget.value);
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
