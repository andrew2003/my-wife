import { translate, type Locale } from "../lib/i18n";
import type { Sheet } from "../lib/timetable-sheet";
import { ScreenState, stateKeys } from "./screen-state";

const SHEET_STATE_KEYS = stateKeys("sheet");

export type TimetableSheetStatus = "loading" | "ready" | "empty" | "error";

export interface TimetableSheetViewProps {
  locale: Locale;
  status: TimetableSheetStatus;
  sheet: Sheet | null;
  /** `entityId:field` of the cell being saved. */
  busyCell: string | null;
  errorKey: string | null;
  onSave: (entityId: string, field: string, text: string) => void;
  onRetry: () => void;
}

const INPUT_TYPE: Record<string, string> = {
  day: "date",
  windowStart: "time",
  windowEnd: "time",
  estimatedMinutes: "number",
};

/** Presentational timetable sheet: white cells are inputs, grey cells are locked text. */
export function TimetableSheetView(props: TimetableSheetViewProps) {
  const { locale, status, sheet, busyCell, errorKey } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={SHEET_STATE_KEYS} />;
  if (status === "empty")
    return <ScreenState locale={locale} kind="empty" keys={SHEET_STATE_KEYS} />;
  if (status === "error" || !sheet) {
    return (
      <ScreenState locale={locale} kind="error" keys={SHEET_STATE_KEYS} onRetry={props.onRetry} />
    );
  }

  const columns = sheet.rows[0]?.cells.map((c) => c.field) ?? [];
  return (
    <div>
      <p>{t("sheet.week_of", { date: sheet.week.firstDay })}</p>
      {sheet.readOnly ? <p role="status">{t("sheet.read_only")}</p> : null}
      {errorKey ? <p role="alert">{t(errorKey)}</p> : null}
      <p>{t("sheet.legend")}</p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              {columns.map((f) => (
                <th key={f} scope="col">
                  {t(`sheet.col.${f}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row) => (
              <tr key={row.entityId}>
                {row.cells.map((cell) => {
                  const text = cell.value === null ? "" : String(cell.value);
                  const label = t(`sheet.col.${cell.field}`);
                  if (!cell.editable) {
                    return (
                      <td key={cell.field} data-locked="true">
                        <span title={t("sheet.locked")}>
                          {cell.field === "state" ? t(`sheet.state.${text}`) : text}
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td key={cell.field}>
                      <input
                        aria-label={label}
                        type={INPUT_TYPE[cell.field] ?? "text"}
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
      <p>{t("sheet.planned_minutes", { minutes: sheet.computed.plannedMinutes })}</p>
    </div>
  );
}
