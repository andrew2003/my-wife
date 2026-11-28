import { translate, type Locale } from "../lib/i18n";
import { buildMonthGrid, lunarLabel } from "../lib/month-calendar";
import { ScreenState, stateKeys } from "./screen-state";

export type MonthCalendarStatus = "loading" | "ready" | "error";

export interface MonthCalendarViewProps {
  locale: Locale;
  status: MonthCalendarStatus;
  year: number;
  month: number;
  /** `YYYY-MM-DD` of the user's today. */
  today: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

const CALENDAR_STATE_KEYS = stateKeys("calendar");

const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Presentational month grid showing the solar and the lunar date of each day. */
export function MonthCalendarView(props: MonthCalendarViewProps) {
  const { locale, status, year, month, today } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  if (status === "loading") {
    return <ScreenState locale={locale} kind="loading" keys={CALENDAR_STATE_KEYS} />;
  }
  if (status === "error") {
    return (
      <ScreenState
        locale={locale}
        kind="error"
        keys={CALENDAR_STATE_KEYS}
        onRetry={props.onToday}
      />
    );
  }

  const grid = buildMonthGrid(year, month);
  const unavailable = grid.flat().some((c) => c !== null && c.lunar === null);
  const title = new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  return (
    <div>
      <div>
        <button type="button" className="button" onClick={props.onPrev}>
          {t("calendar.prev")}
        </button>{" "}
        <strong aria-live="polite">{title}</strong>{" "}
        <button type="button" className="button" onClick={props.onNext}>
          {t("calendar.next")}
        </button>{" "}
        <button type="button" className="button" onClick={props.onToday}>
          {t("calendar.today")}
        </button>
      </div>
      {unavailable ? <p role="note">{t("calendar.lunar_unavailable")}</p> : null}
      <table style={{ width: "100%", tableLayout: "fixed", textAlign: "center" }}>
        <thead>
          <tr>
            {WEEKDAY_KEYS.map((k) => (
              <th key={k} scope="col">
                {t(`calendar.weekday.${k}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week, i) => (
            <tr key={i}>
              {week.map((cell, j) =>
                cell === null ? (
                  <td key={j} />
                ) : (
                  <td
                    key={cell.iso}
                    aria-current={cell.iso === today ? "date" : undefined}
                    style={cell.iso === today ? { fontWeight: "bold", outline: "2px solid" } : {}}
                  >
                    <div data-solar={cell.solarDay}>{cell.solarDay}</div>
                    {cell.lunar ? (
                      <small
                        data-lunar={lunarLabel(cell.lunar)}
                        title={t("calendar.lunar_title", { date: lunarLabel(cell.lunar) })}
                      >
                        {lunarLabel(cell.lunar)}
                      </small>
                    ) : null}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <small>{t("calendar.legend")}</small>
      </p>
    </div>
  );
}
