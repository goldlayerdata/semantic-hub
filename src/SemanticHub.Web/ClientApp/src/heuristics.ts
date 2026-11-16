// Result → visual heuristics (design §5.3), shared by tiles and chat answers.
import { cleanName, isDateColumn, isNumber, isYearColumn } from "./format";
import type { QueryColumn, TileKind } from "./types";

export type Shape = {
  categoryIndex: number;
  seriesIdx: number[];
  timeLike: boolean;
  longLabels: boolean;
};

/** Normalise columns that may arrive as strings or {name,type} objects. */
export function normalizeColumns(cols: (QueryColumn | string)[] | undefined, rows: unknown[][] = []): QueryColumn[] {
  return (cols ?? []).map((c, i) => {
    if (typeof c !== "string") return { name: c.name, type: c.type ?? "" };
    const v = rows.find((r) => r[i] != null)?.[i];
    return { name: c, type: typeof v === "number" ? (Number.isInteger(v) ? "Int64" : "Double") : "String" };
  });
}

export function numericColumns(columns: QueryColumn[], rows: unknown[][], from = 0): number[] {
  return columns
    .map((_, i) => i)
    .filter((i) => i >= from && rows.some((r) => isNumber(r[i])) && rows.every((r) => r[i] == null || isNumber(r[i])) && !/^Compare$/i.test(cleanName(columns[i].name)));
}

export function analyse(columns: QueryColumn[], rows: unknown[][]): Shape {
  const first = rows.map((r) => r[0]);
  const timeLike = columns.length > 0 && (isDateColumn(columns[0], first) || isYearColumn(columns[0], first));
  const seriesIdx = numericColumns(columns, rows, 1);
  const longLabels = first.some((v) => String(v ?? "").length > 14);
  return { categoryIndex: 0, seriesIdx, timeLike, longLabels };
}

export function pickKind(columns: QueryColumn[], rows: unknown[][]): TileKind {
  if (!columns.length || !rows.length) return "table";
  const numericAll = numericColumns(columns, rows, 0);
  const hasCompare = columns.some((c) => /^Compare$/i.test(cleanName(c.name)));
  if (rows.length === 1 && (numericAll.length >= 1 || hasCompare) && columns.length <= 2 && isNumber(rows[0][0])) return "kpi";

  const shape = analyse(columns, rows);
  if (shape.seriesIdx.length === 0) return "table";
  if (shape.timeLike && rows.length >= 3) return shape.seriesIdx.length === 1 ? "area" : "line";
  const firstIsText = rows.every((r) => r[0] == null || typeof r[0] === "string");
  if (firstIsText && shape.seriesIdx.length <= 3) {
    if (rows.length <= 8 && shape.seriesIdx.length === 1 && shareLike(rows, shape.seriesIdx[0], columns)) return "donut";
    return rows.length > 6 || shape.longLabels ? "bar" : "column";
  }
  return "table";
}

/** Parts of a whole: all non-negative and named like a share/mix. Rankings ("top 5 …") stay bars. */
function shareLike(rows: unknown[][], i: number, columns: QueryColumn[]): boolean {
  const vals = rows.map((r) => r[i]).filter(isNumber);
  if (!vals.length || vals.some((v) => v < 0)) return false;
  return /share|%|pct|mix|split|distribution/i.test(cleanName(columns[i].name));
}

/** Kinds that make sense for a result (used by the answer kind switcher). */
export function validKinds(columns: QueryColumn[], rows: unknown[][]): TileKind[] {
  const out: TileKind[] = [];
  if (rows.length === 1 && isNumber(rows[0]?.[0])) out.push("kpi");
  const shape = analyse(columns, rows);
  if (rows.length >= 1 && shape.seriesIdx.length) {
    out.push("bar", "column", "line", "area");
    if (shape.seriesIdx.length >= 1 && rows.length <= 12) out.push("donut");
  }
  out.push("table");
  return out;
}

export const KIND_LABEL: Record<TileKind, string> = {
  kpi: "KPI",
  bar: "Bar",
  column: "Column",
  line: "Line",
  area: "Area",
  donut: "Donut",
  table: "Table",
};
