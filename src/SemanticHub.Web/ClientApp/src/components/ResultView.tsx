import { lazy, Suspense, useMemo } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cleanName, columnFormatter, formatCompact, formatValue, isNumber } from "../format";
import { analyse } from "../heuristics";
import type { QueryColumn, TileFormat, TileKind } from "../types";
import { cx } from "../util";

const EChart = lazy(() => import("./EChart").then((m) => ({ default: m.EChart })));

export type ExplainPoint = { category?: string; series?: string; value: unknown; formatted: string };

type Props = {
  kind: TileKind;
  format: TileFormat;
  columns: QueryColumn[];
  rows: unknown[][];
  truncated?: boolean;
  label?: string;
  onPoint?: (p: ExplainPoint) => void;
  /** KPI number size; tiles use "md", answers "sm". */
  density?: "md" | "sm";
};

/** One renderer for tiles, chat answers, previews and fullscreen: KPI | ECharts | table. */
export function ResultView({ kind, format, columns, rows, truncated, label, onPoint, density = "md" }: Props) {
  if (!rows.length) return <div className="result-empty">No data for the current filters.</div>;
  if (kind === "kpi") return <KpiView format={format} columns={columns} rows={rows} onPoint={onPoint} density={density} label={label} />;
  if (kind === "table") return <DataTable columns={columns} rows={rows} format={format} truncated={truncated} label={label} />;
  const shape = analyse(columns, rows);
  if (!shape.seriesIdx.length) return <DataTable columns={columns} rows={rows} format={format} truncated={truncated} label={label} />;
  return (
    <div className="chart-wrap">
      <Suspense fallback={<div className="skeleton chart-skeleton" aria-hidden />}>
        <EChart
          kind={kind}
          format={format}
          columns={columns}
          rows={rows}
          label={label ? `${label} (${kind} chart; table view available in Fullscreen)` : undefined}
          onPointClick={
            onPoint
              ? (p) => {
                  const ci = columns.findIndex((c) => cleanName(c.name) === p.series);
                  const v = ci >= 0 ? rows[p.rowIndex]?.[ci] : p.value;
                  onPoint({ category: p.category, series: p.series, value: v, formatted: formatValue(v, format) });
                }
              : undefined
          }
        />
      </Suspense>
      {truncated && <div className="result-note">Showing the first {rows.length.toLocaleString()} rows.</div>}
    </div>
  );
}

export function KpiView({
  format,
  columns,
  rows,
  onPoint,
  density = "md",
  label,
}: {
  label?: string;
  format: TileFormat;
  columns: QueryColumn[];
  rows: unknown[][];
  onPoint?: (p: ExplainPoint) => void;
  density?: "md" | "sm";
}) {
  const row = rows[0] ?? [];
  const value = row[0];
  const ci = columns.findIndex((c) => /^Compare$/i.test(cleanName(c.name)));
  const compare = ci >= 0 ? row[ci] : undefined;
  const delta = isNumber(value) && isNumber(compare) && compare !== 0 ? (value - compare) / Math.abs(compare) : null;
  const compact = formatCompact(value, format);
  const full = formatValue(value, format);
  const name = label || (columns[0] ? cleanName(columns[0].name) : "Value");
  const dir = delta == null ? null : delta > 0.0005 ? "up" : delta < -0.0005 ? "down" : "flat";
  const pct = delta == null ? "" : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(delta);

  const number = <span className="kpi-value">{compact}</span>;
  // P1: value and delta sit on fixed rows so KPIs with and without a comparison line up.
  return (
    <div className={cx("kpi", density === "sm" && "is-sm")}>
      {onPoint ? (
        <button
          type="button"
          className="kpi-button"
          title={`${full} — click to see how it's calculated`}
          aria-label={`${name}: ${full}. Explain this number`}
          onClick={() => onPoint({ series: name, value, formatted: compact })}
        >
          {number}
        </button>
      ) : (
        <span title={full}>{number}</span>
      )}
      <div className="kpi-delta-row">
        {dir ? (
          <>
            <span className={cx("delta-chip", `is-${dir}`)} title={`Change vs prior: ${pct}`}>
              {dir === "up" ? <ArrowUpRight size={13} aria-hidden /> : dir === "down" ? <ArrowDownRight size={13} aria-hidden /> : <ArrowRight size={13} aria-hidden />}
              {pct}
            </span>
            <span className="kpi-compare">vs prior {formatCompact(compare, format)}</span>
          </>
        ) : (
          <span className="kpi-compare" aria-hidden>
            &nbsp;
          </span>
        )}
      </div>
    </div>
  );
}

export function DataTable({ columns, rows, format, truncated, label }: { columns: QueryColumn[]; rows: unknown[][]; format: TileFormat; truncated?: boolean; label?: string }) {
  const meta = useMemo(
    () =>
      columns.map((c, i) => {
        const values = rows.map((r) => r[i]);
        const fmt = columnFormatter(c, values, format);
        const numeric = values.some(isNumber) && values.every((v) => v == null || isNumber(v));
        return { name: cleanName(c.name), fmt, numeric };
      }),
    [columns, rows, format],
  );
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label ? `${label} table` : "Result table"}>
      <table className="data-table">
        <thead>
          <tr>
            {meta.map((m, i) => (
              <th key={i} scope="col" className={cx(m.numeric && "num")}>
                {m.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {meta.map((m, ci) => (
                <td key={ci} className={cx(m.numeric && "num")}>
                  {m.fmt(r[ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <div className="result-note">Showing the first {rows.length.toLocaleString()} rows.</div>}
    </div>
  );
}
