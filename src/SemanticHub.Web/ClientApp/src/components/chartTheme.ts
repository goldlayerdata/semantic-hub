// Reads chart colours from CSS tokens so ECharts follows the active theme.
export type ChartTheme = {
  series: string[];
  text: string;
  muted: string;
  text2: string;
  grid: string;
  axis: string;
  surface: string;
  surface2: string;
  border: string;
  font: string;
};

export function readChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    text: v("--text"),
    muted: v("--chart-label"),
    text2: v("--text-2"),
    grid: v("--chart-grid"),
    axis: v("--chart-axis"),
    surface: v("--surface"),
    surface2: v("--surface-2"),
    border: v("--border"),
    font: v("--font"),
  };
}
