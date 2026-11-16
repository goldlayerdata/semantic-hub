import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { useTheme } from "../stores/ui";
import { cleanName, columnFormatter, formatAxis, formatCompact, formatValue, guessColumnFormat, isNumber } from "../format";
import { analyse } from "../heuristics";
import type { QueryColumn, TileFormat, TileKind } from "../types";
import { readChartTheme, type ChartTheme } from "./chartTheme";

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, AriaComponent, CanvasRenderer]);

export type PointClick = { category: string; series: string; value: unknown; formatted: string; rowIndex: number };

type Props = {
  kind: TileKind;
  format: TileFormat;
  columns: QueryColumn[];
  rows: unknown[][];
  onPointClick?: (p: PointClick) => void;
  label?: string;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Effective kind: a column chart with many rows or long labels reads better as horizontal bars. */
export function effectiveKind(kind: TileKind, columns: QueryColumn[], rows: unknown[][]): TileKind {
  if (kind !== "column") return kind;
  const shape = analyse(columns, rows);
  return !shape.timeLike && (rows.length > 6 || shape.longLabels) ? "bar" : "column";
}

function buildOption(kindIn: TileKind, format: TileFormat, columns: QueryColumn[], rows: unknown[][], t: ChartTheme, width: number): EChartsCoreOption {
  const kind = effectiveKind(kindIn, columns, rows);
  const shape = analyse(columns, rows);
  const seriesIdx = shape.seriesIdx.slice(0, 8);
  const catFmt = columnFormatter(columns[0], rows.map((r) => r[0]));
  const categories = rows.map((r) => (r[0] == null ? "(blank)" : catFmt(r[0])));
  const fmts = seriesIdx.map((i) => guessColumnFormat(cleanName(columns[i].name), rows.map((r) => r[i]), format));
  const axisFmt = fmts[0] ?? format;
  const names = seriesIdx.map((i) => cleanName(columns[i].name));
  const textStyle = { color: t.muted, fontFamily: t.font, fontSize: 11 };
  const tooltipBase = {
    confine: true,
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: t.text, fontFamily: t.font, fontSize: 12 },
    extraCssText: "border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.12);",
  };
  const dot = (c: string) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:6px"></span>`;

  if (kind === "donut") {
    const si = seriesIdx[0];
    const data = rows.map((r, i) => ({ name: categories[i], value: isNumber(r[si]) ? r[si] : 0, itemStyle: { color: t.series[i % 8] } }));
    const total = data.reduce((a, d) => a + (d.value as number), 0);
    const side = width >= 420;
    return {
      animationDuration: 300,
      aria: { enabled: true },
      tooltip: {
        ...tooltipBase,
        trigger: "item",
        formatter: (p: { name: string; value: number; percent: number; color: string }) =>
          `${dot(p.color)}${esc(p.name)}<br/><b>${esc(formatValue(p.value, fmts[0]))}</b> <span style="color:${t.muted}">· ${p.percent}%</span>`,
      },
      legend: {
        type: "scroll",
        orient: side ? "vertical" : "horizontal",
        right: side ? 8 : undefined,
        bottom: side ? undefined : 0,
        top: side ? "middle" : undefined,
        icon: "roundRect",
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { ...textStyle, color: t.text },
        pageTextStyle: textStyle,
        formatter: (n: string) => trunc(n, 22),
      },
      title: {
        text: formatCompact(total, fmts[0]),
        subtext: "Total",
        left: side ? "34%" : "center",
        top: side ? "40%" : "34%",
        textAlign: side ? "center" : undefined,
        // Fit the total inside the hole: the ring's inner diameter shrinks with the tile.
        textStyle: { color: t.text, fontSize: Math.max(10, Math.min(18, Math.round(((side ? width * 0.6 : width) * 0.5) / Math.max(4, formatCompact(total, fmts[0]).length) * 1.3))), fontWeight: 600, fontFamily: t.font },
        subtextStyle: { color: t.muted, fontSize: 11, fontFamily: t.font },
        itemGap: 2,
      },
      series: [
        {
          type: "pie",
          name: names[0],
          radius: ["56%", "80%"],
          center: side ? ["35%", "50%"] : ["50%", "44%"],
          avoidLabelOverlap: true,
          label: { show: false },
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
          emphasis: { scale: true, scaleSize: 4 },
          data,
        },
      ],
    };
  }

  const horizontal = kind === "bar";
  const isLine = kind === "line" || kind === "area";
  const multi = seriesIdx.length > 1;
  // P5: value labels only when there are few bars (≤ 8) so they never crowd; dashed, faint gridlines.
  const barCount = rows.length * seriesIdx.length;
  const labelBars = !isLine && barCount <= 8;
  const valueAxis = {
    type: "value",
    axisLabel: { ...textStyle, formatter: (v: number) => formatAxis(v, axisFmt) },
    splitLine: { lineStyle: { color: t.grid, width: 1, type: [3, 3] as number[] } },
    axisLine: { show: false },
    axisTick: { show: false },
  };
  const categoryAxis = {
    type: "category",
    data: categories,
    inverse: horizontal,
    boundaryGap: !isLine,
    axisLabel: {
      ...textStyle,
      hideOverlap: true,
      formatter: (v: string) => trunc(v, horizontal ? 20 : 14),
    },
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
  };

  const series = seriesIdx.map((ci, n) => {
    const color = t.series[n % 8];
    const data = rows.map((r) => (isNumber(r[ci]) ? r[ci] : null));
    if (isLine)
      return {
        type: "line",
        name: names[n],
        data,
        smooth: false,
        symbol: "circle",
        symbolSize: 8,
        showSymbol: rows.length <= 24,
        lineStyle: { width: 2, color, cap: "round", join: "round" },
        itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
        areaStyle: kind === "area" ? { color, opacity: multi ? 0.08 : 0.12 } : undefined,
        emphasis: { focus: multi ? "series" : "none" },
        connectNulls: false,
      };
    return {
      type: "bar",
      name: names[n],
      data,
      barMaxWidth: 24,
      barGap: "12%",
      itemStyle: { color, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
      label: labelBars
        ? {
            show: true,
            position: horizontal ? "right" : "top",
            distance: 4,
            color: t.text2,
            fontFamily: t.font,
            fontSize: 11,
            formatter: (p: { value: unknown }) => formatCompact(p.value, fmts[n] ?? format),
          }
        : undefined,
      emphasis: { focus: multi ? "series" : "none" },
    };
  });

  return {
    animationDuration: 300,
    aria: { enabled: true },
    grid: { left: 4, right: horizontal ? (labelBars ? 56 : 20) : 12, top: multi ? 34 : labelBars ? 20 : 12, bottom: 4, containLabel: true },
    legend: multi
      ? { top: 0, left: 0, type: "scroll", icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { ...textStyle, color: t.text }, pageTextStyle: textStyle }
      : undefined,
    tooltip: {
      ...tooltipBase,
      trigger: "axis",
      axisPointer: isLine ? { type: "line", lineStyle: { color: t.axis } } : { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.6 } },
      formatter: (ps: { dataIndex: number; seriesIndex: number; color: string; value: unknown; seriesName: string }[]) => {
        if (!ps.length) return "";
        const head = `<div style="margin-bottom:4px;font-weight:600">${esc(categories[ps[0].dataIndex] ?? "")}</div>`;
        return (
          head +
          ps
            .map(
              (p) =>
                `<div style="display:flex;align-items:center;gap:12px;justify-content:space-between"><span>${dot(p.color)}${esc(p.seriesName)}</span><b style="font-variant-numeric:tabular-nums">${esc(formatValue(p.value, fmts[p.seriesIndex] ?? format))}</b></div>`,
            )
            .join("")
        );
      },
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series,
  };
}

export function EChart({ kind, format, columns, rows, onPointClick, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;
  const resolved = useTheme((s) => s.resolved);
  // Width bucket (~60 px steps): options that depend on size (label density, donut total) rebuild when it changes.
  const [widthBucket, setWidthBucket] = useState(0);

  useEffect(() => {
    const el = ref.current!;
    const c = echarts.init(el, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => {
      c.resize();
      setWidthBucket(Math.round(el.clientWidth / 60));
    });
    ro.observe(el);
    c.on("click", (p) => {
      const params = p as unknown as { dataIndex: number; seriesName: string; value: unknown; name: string };
      const cb = clickRef.current;
      if (!cb || params.dataIndex == null) return;
      const v = typeof params.value === "object" && params.value !== null && "value" in (params.value as object) ? (params.value as { value: unknown }).value : params.value;
      cb({ category: params.name, series: params.seriesName, value: v, formatted: "", rowIndex: params.dataIndex });
    });
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c || !ref.current) return;
    // Colours come from CSS tokens; the theme attribute is already applied when this runs.
    const option = buildOption(kind, format, columns, rows, readChartTheme(), ref.current.clientWidth || 600);
    c.setOption(option, { notMerge: true });
  }, [kind, format, columns, rows, resolved, widthBucket, onPointClick]);

  return <div ref={ref} className="echart" role="img" aria-label={label ?? "Chart"} style={{ cursor: onPointClick ? "pointer" : undefined }} />;
}
