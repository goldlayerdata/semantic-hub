// Value formatting (ported from v1 common.js, extended for dates and year-like columns).
import type { QueryColumn, Scalar, TileFormat } from "./types";

const nf = (o: Intl.NumberFormatOptions) => new Intl.NumberFormat(undefined, o);

// v3 (D8): the model's currency symbol, set from spec.currency when a dashboard loads.
let currencySymbol = "";
export function setCurrency(symbol: string | null | undefined) {
  currencySymbol = (symbol ?? "").trim();
}
export function getCurrency() {
  return currencySymbol;
}
/** "$1.2M", "€950", "1.2M kr" (letter symbols go after), "-$40". */
function withCurrency(text: string): string {
  if (!currencySymbol) return text;
  const neg = text.startsWith("-") || text.startsWith("−");
  const body = neg ? text.slice(1) : text;
  const suffix = /^[a-z]{2,}$/i.test(currencySymbol);
  return `${neg ? "-" : ""}${suffix ? `${body} ${currencySymbol}` : `${currencySymbol}${body}`}`;
}
const fmtPercent = nf({ style: "percent", maximumFractionDigits: 1 });
const fmtInt = nf({ maximumFractionDigits: 0 });
const fmtBig = nf({ maximumFractionDigits: 0 });
const fmtSmall = nf({ maximumFractionDigits: 2 });
const fmtCompact = nf({ notation: "compact", maximumFractionDigits: 1 });
const fmtCompact2 = nf({ notation: "compact", maximumFractionDigits: 2 });

/** "sales[OrderDate]" → "OrderDate", "[Revenue]" → "Revenue", "'date'[Year]" → "Year". */
export function cleanName(name: string): string {
  const m = /\[([^\]]*)\]$/.exec(name ?? "");
  return m ? m[1] : name;
}

export function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE.test(v);
}

export function isDateColumn(col: QueryColumn | undefined, values: unknown[]): boolean {
  if (col && /date|time/i.test(col.type)) return true;
  const sample = values.filter((v) => v != null).slice(0, 20);
  return sample.length > 0 && sample.every(isIsoDate);
}

/** Integer column that holds years (2019, 2020 …): never thousands-separated. */
export function isYearColumn(col: QueryColumn | undefined, values: unknown[]): boolean {
  const sample = values.filter((v) => v != null).slice(0, 50);
  if (!sample.length) return false;
  const allYears = sample.every((v) => {
    const n = typeof v === "string" && /^\d{4}$/.test(v) ? Number(v) : v;
    return isNumber(n) && Number.isInteger(n) && n >= 1900 && n <= 2100;
  });
  if (!allYears) return false;
  const name = col ? cleanName(col.name) : "";
  return /year|yr|fy|jahr|année|año/i.test(name) || sample.every((v) => typeof v === "number");
}

function parseDate(v: string): Date {
  // Date-only ISO strings parse as UTC; treat everything as local wall time instead.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) return new Date(v);
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

/** Date formatting adapted to the column's grain: month-starts read as "Jan 2025". */
export function dateFormatter(values: unknown[]): (v: unknown) => string {
  const dates = values.filter(isIsoDate).map(parseDate);
  const monthly = dates.length > 1 && dates.every((d) => d.getDate() === 1);
  const yearly = monthly && dates.every((d) => d.getMonth() === 0);
  const hasTime = dates.some((d) => d.getHours() || d.getMinutes());
  const f = yearly
    ? new Intl.DateTimeFormat(undefined, { year: "numeric" })
    : monthly
      ? new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" })
      : hasTime
        ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
        : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  return (v) => (isIsoDate(v) ? f.format(parseDate(v)) : v == null ? "(blank)" : String(v));
}

export function formatValue(v: unknown, format: TileFormat = "number"): string {
  if (v == null) return "–";
  if (!isNumber(v)) return typeof v === "boolean" ? (v ? "True" : "False") : String(v);
  if (format === "percent") return fmtPercent.format(v);
  if (format === "integer") return fmtInt.format(v);
  const text = Math.abs(v) >= 100 ? fmtBig.format(v) : fmtSmall.format(v);
  return format === "currency" ? withCurrency(text) : text;
}

/** Short form for KPIs and axes: 12.9K / 4.2M; values under 10,000 stay in full. */
export function formatCompact(v: unknown, format: TileFormat = "number"): string {
  if (v == null) return "–";
  if (!isNumber(v)) return String(v);
  if (format === "percent") return formatValue(v, format);
  if (Math.abs(v) < 10000) return formatValue(v, format);
  const text = fmtCompact2.format(v);
  return format === "currency" ? withCurrency(text) : text;
}

export function formatAxis(v: number, format: TileFormat = "number"): string {
  if (format === "percent") return fmtPercent.format(v);
  const text = Math.abs(v) < 10000 ? fmtSmall.format(v) : fmtCompact.format(v);
  return format === "currency" ? withCurrency(text) : text;
}

/** A result can mix money, counts and ratios; only trust the tile format for non-ratio columns (v1 rule). */
export function guessColumnFormat(name: string, values: unknown[], tileFormat: TileFormat = "number"): TileFormat {
  const nums = values.filter(isNumber);
  if (/%|pct|percent|share|rate|ratio|margin/i.test(name) && nums.every((n) => Math.abs(n) <= 5)) return "percent";
  // Counts stay plain even on a currency tile ("Units", "Orders"); whole-number money keeps the symbol.
  if (/unit|qty|quantity|count|orders|customers|transactions|items|#|number of/i.test(name)) return "integer";
  if (nums.length && nums.every((n) => Number.isInteger(n)) && tileFormat !== "percent") return tileFormat === "currency" ? "currency" : "integer";
  return tileFormat === "percent" ? "number" : tileFormat;
}

/** Guess a tile format for a fresh result (used when pinning a chat answer). */
export function guessFormat(columns: QueryColumn[], rows: unknown[][]): TileFormat {
  const idx = columns.findIndex((_, i) => rows.some((r) => isNumber(r[i])) && !isYearColumn(columns[i], rows.map((r) => r[i])));
  if (idx < 0) return "number";
  const name = cleanName(columns[idx].name);
  const values = rows.map((r) => r[idx]).filter(isNumber);
  if (/%|pct|percent|share|rate|ratio|margin/i.test(name) && values.every((n) => Math.abs(n) <= 5)) return "percent";
  if (/revenue|sales|amount|price|cost|profit|spend|income|value|\$|€|£|usd|eur|gbp/i.test(name)) return "currency";
  if (values.every((n) => Number.isInteger(n))) return "integer";
  return "number";
}

/** A cell formatter for one column of a result. */
export function columnFormatter(col: QueryColumn, values: unknown[], tileFormat: TileFormat = "number"): (v: unknown) => string {
  if (isDateColumn(col, values)) return dateFormatter(values);
  if (isYearColumn(col, values)) return (v) => (v == null ? "(blank)" : String(v));
  const fmt = guessColumnFormat(cleanName(col.name), values, tileFormat);
  return (v) => (isNumber(v) ? formatValue(v, fmt) : v == null ? "" : typeof v === "boolean" ? (v ? "True" : "False") : String(v));
}

export function formatScalar(v: Scalar | unknown): string {
  if (v == null) return "(blank)";
  if (isIsoDate(v)) return dateFormatter([v])(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

export function filtersText(filters: { label: string; values: unknown[] }[]): string {
  return filters
    .filter((f) => f.values.length)
    .map((f) => `${f.label} = ${f.values.map(formatScalar).join(", ")}`)
    .join("; ");
}
