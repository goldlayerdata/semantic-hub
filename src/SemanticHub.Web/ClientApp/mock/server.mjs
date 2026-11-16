// Mock of the Semantic Hub API (docs/v2-api.md) with made-up retail data, for UI work and design reviews without
// Power BI Desktop and without real model data. Run: `npm run dev:mock` (mock on :5090 + Vite on :5173).
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT) || 5090; // MOCK_PORT lets a second copy run alongside
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fake model ----------
const YEARS = [2023, 2024, 2025];
const CATEGORIES = ["Audio", "Cameras", "Computers", "Phones", "TV & Video", "Home Appliances"];
const COUNTRIES = ["United States", "Germany", "United Kingdom", "France", "Canada", "Australia"];
const CHANNELS = ["Online", "Store", "Reseller"];
const PRODUCTS = ["Studio Headphones X2", "Ultrabook 14 Pro", "Phone 12 Max", "Mirrorless M50", "OLED TV 55", "Soundbar 300", "Tablet Air", "Smartwatch S", "Laptop 16 Creator", "Action Cam 4K"];

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const base = {};
for (const y of YEARS) for (const c of CATEGORIES) for (const k of COUNTRIES)
  base[`${y}|${c}|${k}`] = 40000 + rnd() * 160000 * (1 + (y - 2023) * 0.18) * (c === "Computers" ? 2.2 : c === "Phones" ? 1.7 : 1);

const pick = (filters, column, all) => {
  const f = (filters ?? []).find((x) => x.column === column && x.values?.length);
  return f ? all.filter((v) => f.values.includes(v)) : all;
};
const revenue = (filters, { years, cats, countries } = {}) => {
  let total = 0;
  for (const y of years ?? pick(filters, "Year", YEARS))
    for (const c of cats ?? pick(filters, "Category", CATEGORIES))
      for (const k of countries ?? pick(filters, "Country", COUNTRIES)) total += base[`${y}|${c}|${k}`] ?? 0;
  return Math.round(total);
};

const tiles = [
  { id: "kpi-revenue", title: "Revenue", kind: "kpi", format: "currency", size: "small", description: "Net sales after discounts.", origin: "designer", filterable: true, expression: 'ROW("Value", [Revenue], "Compare", [Revenue PY])' },
  { id: "kpi-orders", title: "Orders", kind: "kpi", format: "integer", size: "small", description: "Distinct sales orders.", origin: "designer", filterable: true, expression: 'ROW("Value", [Orders], "Compare", [Orders PY])' },
  { id: "kpi-aov", title: "Avg order value", kind: "kpi", format: "currency", size: "small", description: "Revenue per order.", origin: "designer", filterable: true, expression: 'ROW("Value", [AOV])' },
  { id: "kpi-margin", title: "Margin %", kind: "kpi", format: "percent", size: "small", description: "Gross margin as a share of revenue.", origin: "designer", filterable: true, expression: 'ROW("Value", [Margin %], "Compare", [Margin % PY])' },
  { id: "trend", title: "Revenue by month", kind: "area", format: "currency", size: "large", description: "Monthly revenue over the selected years.", origin: "designer", filterable: true, expression: "SUMMARIZECOLUMNS('date'[Month], \"Revenue\", [Revenue])", orderBy: "'date'[Month] ASC" },
  { id: "channel", title: "Revenue by channel", kind: "donut", format: "currency", size: "small", description: "Share of revenue per sales channel.", origin: "designer", filterable: true, expression: "SUMMARIZECOLUMNS('channel'[Channel], \"Revenue\", [Revenue])" },
  { id: "category", title: "Revenue by category", kind: "bar", format: "currency", size: "medium", description: "Revenue per product category.", origin: "designer", filterable: true, expression: "SUMMARIZECOLUMNS('product'[Category], \"Revenue\", [Revenue])", orderBy: "[Revenue] DESC" },
  { id: "country", title: "Revenue vs last year by country", kind: "column", format: "currency", size: "medium", description: "This year and last year per country.", origin: "designer", filterable: true, expression: "SUMMARIZECOLUMNS('customer'[Country], \"Revenue\", [Revenue], \"Revenue PY\", [Revenue PY])" },
  { id: "products", title: "Top products", kind: "table", format: "currency", size: "full", description: "Best sellers by revenue.", origin: "designer", filterable: true, expression: "TOPN(10, SUMMARIZECOLUMNS('product'[Product], 'product'[Category], \"Revenue\", [Revenue], \"Units\", [Units]), [Revenue], DESC)", orderBy: "[Revenue] DESC" },
];
let spec = {
  title: "Retail performance", subtitle: "Sales, orders and margin across categories, countries and channels.", version: 2,
  tiles, filters: [{ table: "date", column: "Year", label: "Year" }, { table: "product", column: "Category", label: "Category" }, { table: "customer", column: "Country", label: "Country" }],
  generatedAt: new Date().toISOString(), generatedBy: "mock", droppedTiles: [],
  currency: "$", // v3 (D8): the real server derives this from the measures' format strings
};

const col = (name, type) => ({ name, type });
function runTile(tile, filters) {
  const r = revenue(filters);
  const py = (() => { const ys = pick(filters, "Year", YEARS).map((y) => y - 1).filter((y) => YEARS.includes(y)); return ys.length ? revenue(filters, { years: ys }) : r * 0.86; })();
  const orders = Math.round(r / 412);
  switch (tile.id) {
    case "kpi-revenue": return [[col("Value", "Double"), col("Compare", "Double")], [[r, py]]];
    case "kpi-orders": return [[col("Value", "Int64"), col("Compare", "Int64")], [[orders, Math.round(py / 405)]]];
    case "kpi-aov": return [[col("Value", "Double")], [[r / orders]]];
    case "kpi-margin": return [[col("Value", "Double"), col("Compare", "Double")], [[0.412, 0.398]]];
    case "trend": {
      const rows = [];
      for (const y of pick(filters, "Year", YEARS)) for (let m = 1; m <= 12; m++)
        rows.push([`${y}-${String(m).padStart(2, "0")}-01T00:00:00`, Math.round((revenue(filters, { years: [y] }) / 12) * (0.8 + 0.35 * Math.sin((m / 12) * Math.PI * 2 - 1) + (m === 11 || m === 12 ? 0.3 : 0)))]);
      return [[col("Month", "DateTime"), col("Revenue", "Double")], rows];
    }
    case "channel": return [[col("Channel", "String"), col("Revenue", "Double")], CHANNELS.map((c, i) => [c, Math.round(r * [0.46, 0.38, 0.16][i])])];
    case "category": return [[col("Category", "String"), col("Revenue", "Double")], pick(filters, "Category", CATEGORIES).map((c) => [c, revenue(filters, { cats: [c] })]).sort((a, b) => b[1] - a[1])];
    case "country": return [[col("Country", "String"), col("Revenue", "Double"), col("Revenue PY", "Double")], pick(filters, "Country", COUNTRIES).map((k) => { const v = revenue(filters, { countries: [k] }); return [k, v, Math.round(v * (0.78 + rnd() * 0.2))]; })];
    case "products": return [[col("Product", "String"), col("Category", "String"), col("Revenue", "Double"), col("Units", "Int64")], PRODUCTS.map((p, i) => [p, CATEGORIES[i % CATEGORIES.length], Math.round(r * (0.09 - i * 0.006)), Math.round((r * (0.09 - i * 0.006)) / (300 + i * 90))])];
    default: return [[col("Category", "String"), col("Revenue", "Double")], CATEGORIES.map((c) => [c, revenue(filters, { cats: [c] })])];
  }
}
const tileResult = (tile, filters) => {
  const [columns, rows] = runTile(tile, filters);
  const filtered = !!filters?.some((f) => f.values?.length);
  return { tileId: tile.id, ok: true, columns, rows, truncated: false, durationMs: 4 + Math.round(rnd() * 20), filtered,
    query: `EVALUATE\n${filtered ? `CALCULATETABLE(\n    ${tile.expression},\n    ${filters.filter((f) => f.values?.length).map((f) => `TREATAS({${f.values.map((v) => JSON.stringify(v)).join(", ")}}, '${f.table}'[${f.column}])`).join(",\n    ")}\n)` : tile.expression}${tile.orderBy ? `\nORDER BY ${tile.orderBy}` : ""}` };
};

const audit = [];
const model = { id: "demo-retail", name: "Demo Retail", route: "desktop", sourcePath: "C:\\Demo\\Demo Retail.pbix", addedAt: new Date().toISOString(), online: true,
  schemaHarvestedAt: new Date(Date.now() - 3600_000).toISOString(), counts: { tables: 7, columns: 64, measures: 18 },
  health: { measures: 18, measuresWithoutDescription: 2, visibleColumns: 64, columnsWithoutDescription: 11, tablesWithoutDescription: 1 }, hasDashboard: true };

// ---------- http ----------
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } }); });
const sse = (res) => { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); return (o) => res.write(`data: ${JSON.stringify(o)}\n\n`); };

// One bad request must not take the whole mock down.
http.createServer((req, res) => handle(req, res).catch((e) => {
  console.error("mock error:", e);
  try { if (!res.headersSent) json(res, 500, { error: `Mock error: ${e.message}` }); else res.end(); } catch {}
})).listen(PORT, () => console.log(`mock API on http://localhost:${PORT}`));

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/^\/api/, "");
  const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
  let m;

  if (p === "/status") return json(res, 200, { llm: { provider: "local", model: "qwen/qwen3-14b", ready: true, problem: null, warning: null, local: true, endpoint: "http://localhost:1234/v1" }, limits: { maxRows: 500, queryTimeoutSeconds: 30, maxToolCallsPerQuestion: 10 }, dataDirectory: "C:\\mock" });
  if (p === "/models") return json(res, 200, [model]);
  if (p === "/discovered") return json(res, 200, [{ key: "k", name: "Demo Retail", route: "desktop", sourcePath: model.sourcePath, hubId: model.id }]);
  if (p === "/audit") return json(res, 200, audit.slice().reverse());
  if ((m = p.match(/^\/models\/[^/]+\/dashboard$/))) return json(res, 200, spec);
  if (p.endsWith("/filters/columns")) return json(res, 200, [...spec.filters, { table: "channel", column: "Channel", label: "Channel" }]);
  if (p.endsWith("/filters/values")) {
    const c = url.searchParams.get("column");
    return json(res, 200, { values: c === "Year" ? YEARS : c === "Category" ? CATEGORIES : c === "Country" ? COUNTRIES : CHANNELS, truncated: false });
  }
  if ((m = p.match(/\/dashboard\/tiles\/([^/]+)\/run$/))) {
    await sleep(150 + rnd() * 500);
    const t = spec.tiles.find((x) => x.id === m[1]);
    if (!t) return json(res, 400, { error: `Unknown tile '${m[1]}'.` });
    audit.push({ at: new Date().toISOString(), source: "dashboard", modelId: model.id, question: `tile: ${t.title}`, dax: t.expression, rows: 5, durationMs: 9, rejected: false });
    return json(res, 200, tileResult(t, body.filters));
  }
  if (p.endsWith("/dashboard/run")) return json(res, 200, spec.tiles.map((t) => tileResult(t, body.filters)));
  if ((m = p.match(/\/dashboard\/tiles\/([^/]+)\/explain$/))) {
    const t = spec.tiles.find((x) => x.id === m[1]);
    return json(res, 200, { tileId: t.id, title: t.title, description: t.description, filterable: true, query: tileResult(t, body.filters).query,
      measures: [{ name: "Revenue", table: "sales", description: "Net sales after discounts.", expression: "SUMX ( sales, sales[Quantity] * sales[Net Price] )", formatString: "$#,0" }],
      columns: [], filters: (body.filters ?? []).filter((f) => f.values?.length).map((f) => ({ label: f.column, values: f.values })) });
  }
  if ((m = p.match(/\/dashboard\/tiles\/([^/]+)\/export$/))) { res.writeHead(200, { "content-type": "text/csv" }); return res.end("Category,Revenue\nAudio,1\n"); }
  if (p.endsWith("/dashboard/layout") && req.method === "PUT") {
    const byId = Object.fromEntries(spec.tiles.map((t) => [t.id, t]));
    for (const l of body.tiles ?? []) if (!byId[l.id]) return json(res, 400, { error: `Unknown tile '${l.id}'.` });
    // v3 layout bounds, same as the server: 0 ≤ x, 1 ≤ w, x + w ≤ 24, 0 ≤ y ≤ 1000, 3 ≤ h ≤ 60; size follows width.
    for (const l of body.tiles ?? []) {
      const g = l.layout;
      if (!g) continue;
      const ok = [g.x, g.y, g.w, g.h].every(Number.isInteger) && g.x >= 0 && g.w >= 1 && g.x + g.w <= 24 && g.y >= 0 && g.y <= 1000 && g.h >= 3 && g.h <= 60;
      if (!ok) return json(res, 400, { error: `Tile '${l.id}' has an out-of-range layout.` });
      l.size = g.w <= 6 ? "small" : g.w <= 12 ? "medium" : g.w <= 18 ? "large" : "full";
    }
    // Same rule as the server: unlisted tiles are kept; only `removed` deletes.
    const removed = new Set(body.removed ?? []);
    const listed = new Set((body.tiles ?? []).map((l) => l.id));
    for (const id of listed) if (removed.has(id)) return json(res, 400, { error: `Tile '${id}' is both listed and removed.` });
    spec = { ...spec, title: body.title ?? spec.title, filters: body.filters ?? spec.filters,
      tiles: [
        ...(body.tiles ?? []).map((l) => ({ ...byId[l.id], ...Object.fromEntries(Object.entries(l).filter(([k, v]) => v != null && ["title", "kind", "size", "format", "layout"].includes(k))) })),
        ...spec.tiles.filter((t) => !listed.has(t.id) && !removed.has(t.id)),
      ] };
    return json(res, 200, spec);
  }
  if (p.endsWith("/dashboard/pin")) {
    spec = { ...spec, tiles: [...spec.tiles, { id: `pinned-${Date.now()}`, title: body.title, kind: body.kind ?? "bar", format: body.format ?? "number", size: "medium", origin: "pinned", filterable: true, expression: "SUMMARIZECOLUMNS('product'[Category], \"Revenue\", [Revenue])" }] };
    return json(res, 200, spec);
  }
  if (p.endsWith("/dashboard/tiles/suggest")) {
    const send = sse(res);
    for (const t of ["Writing the tile query…", "Checking it against the model…"]) { send({ type: "progress", text: t }); await sleep(900); }
    const tile = { id: "s1", title: "Revenue by country", kind: "bar", format: "currency", size: "medium", origin: "added", filterable: true, expression: "x" };
    send({ type: "done", suggestionId: "sug-1", tile, result: { ...tileResult({ ...tile, id: "category" }, body.filters), tileId: "s1" } });
    return res.end();
  }
  if (p.endsWith("/dashboard/tiles") && req.method === "POST") {
    spec = { ...spec, tiles: [...spec.tiles, { id: `added-${Date.now()}`, title: "Revenue by country", kind: "bar", format: "currency", size: "medium", origin: "added", filterable: true, expression: "SUMMARIZECOLUMNS('product'[Category], \"Revenue\", [Revenue])" }] };
    return json(res, 200, spec);
  }
  if (p === "/chat") {
    const send = sse(res);
    const id = body.conversationId ?? "conv-1";
    send({ type: "session", conversationId: id });
    send({ type: "stage", stage: "understanding", text: "Understanding the question" });
    await sleep(1800);
    const dax = "EVALUATE TOPN(5, SUMMARIZECOLUMNS('product'[Category], \"Revenue\", [Revenue]), [Revenue], DESC) ORDER BY [Revenue] DESC";
    send({ type: "tool", toolId: "t1", tool: "run_dax", modelId: model.id, dax });
    send({ type: "stage", stage: "running", text: "Running query", toolId: "t1" });
    await sleep(400);
    const [columns, rows] = runTile({ id: "category" }, body.filters);
    const top = rows.slice(0, 5);
    send({ type: "tool_result", toolId: "t1", ok: true, rows: top.length, durationMs: 8, columns, preview: top });
    send({ type: "stage", stage: "reading", text: "Reading the results", toolId: "t1" });
    await sleep(1500);
    send({ type: "stage", stage: "answering", text: "Writing the answer" });
    const money = (v) => `$${(v / 1e6).toFixed(2)}M`;
    const active = (body.filters ?? []).filter((f) => f.values?.length);
    const scope = active.length ? active.map((f) => `${f.column} = ${f.values.join(", ")}`).join("; ") : "all years, all countries";
    const lead = top.length === 0 ? "No categories match the current filters."
      : top.length === 1 ? `**${top[0][0]}** has **${money(top[0][1])}** in revenue.`
      : `**${top[0][0]}** leads with **${money(top[0][1])}** in revenue, followed by ${top.slice(1, 3).map((r) => r[0]).join(" and ")}.`;
    const table = top.length > 1 ? `\n\n| Category | Revenue |\n|---|---:|\n${top.map((r) => `| ${r[0]} | ${money(r[1])} |`).join("\n")}` : "";
    const text = `${lead}${table}\n\nMeasure: Revenue (${scope}). _Demo data, scripted answer._`;
    for (const chunk of text.match(/.{1,12}/gs)) { send({ type: "text", text: chunk }); await sleep(40); }
    send({ type: "answer_data", toolId: "t1", dax, columns, rows: top, truncated: false });
    send({ type: "done", usage: { provider: "local", model: "qwen/qwen3-14b", inputTokens: 6200, outputTokens: 180, toolCalls: 1 }, elapsedMs: 4400 });
    audit.push({ at: new Date().toISOString(), source: "agent", modelId: model.id, conversationId: id, question: body.question, dax, rows: 5, durationMs: 8, rejected: false });
    return res.end();
  }
  if (p.startsWith("/chat/")) return json(res, 204);
  json(res, 404, { error: `Mock has no ${req.method} ${p}` });
}
