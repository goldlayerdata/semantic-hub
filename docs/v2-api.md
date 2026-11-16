# API reference (current)

_The current HTTP API (introduced in v2, extended in v3). The contract between the React app (`src/SemanticHub.Web/ClientApp`) and the .NET backend. JSON is camelCase. Implements [v2-ui-design.md](v2-ui-design.md)._

All paths are under `/api`. Errors are `{ "error": "readable message" }` with 4xx. SSE endpoints are `POST` and stream `data: {json}\n\n` lines (read with `fetch` + a stream reader, not `EventSource`).

## Shared types

```ts
type FilterDef   = { table: string; column: string; label: string };
type FilterValue = { table: string; column: string; values: (string | number | boolean | null)[] };
type QueryColumn = { name: string; type: string };          // type: "String" | "Int64" | "Double" | "Decimal" | "DateTime" | "Boolean" | …

type Tile = {
  id: string; title: string;
  kind: "kpi" | "bar" | "column" | "line" | "area" | "donut" | "table";
  format: "number" | "integer" | "currency" | "percent";
  size: "small" | "medium" | "large" | "full";               // 3 / 6 / 9 / 12 of 12 grid columns
  description?: string;
  origin: "designer" | "builtin" | "pinned" | "added";
  filterable: boolean;                                       // false = "fixed" tile, ignores the filter bar
  expression?: string; orderBy?: string; dax?: string;       // display only; the browser never sends DAX back
  layout?: { x: number; y: number; w: number; h: number } | null;   // v3: 24-column grid units; null = auto-place
};

type DashboardSpec = {
  title: string; subtitle?: string; version: number;
  tiles: Tile[]; filters: FilterDef[];
  generatedAt: string; generatedBy: string; droppedTiles: string[];
  currency?: string | null;                                  // v3: symbol used by the model's measures, e.g. "$"
};

type TileResult = {
  tileId: string; ok: boolean; error?: string;
  columns: QueryColumn[]; rows: any[][];                     // dates arrive as ISO strings
  truncated: boolean; durationMs: number;
  query?: string;                                            // the exact DAX that ran (for "View query")
  filtered: boolean;                                         // true when the filter bar was applied
};
```

KPI convention: first row; column 0 = value; optional column named `Compare` = comparison value (show delta %).
Chart convention: column 0 = category; following numeric columns = series.

## Status & hub

| | |
|---|---|
| `GET /status` | `{ llm: { provider: "local"\|"claude", model, ready, problem, warning, endpoint }, limits: { maxRows, queryTimeoutSeconds, maxToolCallsPerQuestion }, dataDirectory }` |
| `GET /discovered` | `[{ key, name, route, sourcePath, hubId }]` (`hubId` null = not in hub yet) |
| `GET /models` | `[{ id, name, route, sourcePath, addedAt, online, schemaHarvestedAt, counts: {tables, columns, measures} \| null, health: {measures, measuresWithoutDescription, visibleColumns, columnsWithoutDescription, tablesWithoutDescription} \| null, hasDashboard }]` |
| `POST /models/approve` **SSE** `{ key }` | `{type:"progress", step:"connect"\|"schema"\|"profile", text}` … `{type:"done", model}` \| `{type:"error", error}` |
| `DELETE /models/{id}` | 204 |
| `GET /models/{id}/schema` | `{ harvestedAt, tables[{name, description, isHidden, dataCategory}], columns[{table, name, dataType, description, isHidden}], measures[{table, name, expression, dataType, formatString, description, isHidden, displayFolder}], relationships[…], profile: string[] }` |
| `POST /models/{id}/schema/refresh` | schema |

## Dashboard

| | |
|---|---|
| `GET /models/{id}/dashboard` | `DashboardSpec` or 204 (none yet) |
| `POST /models/{id}/dashboard/design` **SSE** | `{type:"progress", text}` … `{type:"done", spec}` \| `{type:"error", error}` — takes 30–120 s on a local model |
| `POST /models/{id}/dashboard/run` `{ filters: FilterValue[] }` | `TileResult[]` (all tiles) |
| `POST /models/{id}/dashboard/tiles/{tileId}/run` `{ filters }` | `TileResult` (one tile; the app runs tiles individually, 3 at a time, so they appear progressively) |
| `GET /models/{id}/filters/columns` | `[{ table, column, dataType, label }]` — visible columns that make sense as filters |
| `GET /models/{id}/filters/values?table=&column=` | `{ values: any[], truncated: boolean }` (max 500, sorted) |
| `POST /models/{id}/dashboard/tiles/{tileId}/explain` `{ filters }` | `Explain` (below) |
| `POST /models/{id}/dashboard/tiles/{tileId}/export` `{ filters }` | `text/csv` body |
| `POST /models/{id}/dashboard/tiles/suggest` **SSE** `{ request, filters }` | `{type:"progress", text}` … `{type:"done", suggestionId, tile: Tile, result: TileResult}` \| `{type:"error", error}` — preview only, not saved |
| `POST /models/{id}/dashboard/tiles` `{ suggestionId }` | `DashboardSpec` (tile appended) |
| `POST /models/{id}/dashboard/pin` `{ conversationId, toolId, title, kind, format }` | `DashboardSpec` (tile appended) |
| `PUT /models/{id}/dashboard/layout` `{ title?, tiles: [{id, title, kind, size, format, layout?}], filters: FilterDef[], removed?: string[] }` | `DashboardSpec`. The `tiles` array gives order and display fields; **tiles not listed are kept** (appended); only ids in `removed` are deleted (unknown ids there are ignored; an id both listed and removed → 400); unknown listed ids → 400. Every save keeps the previous version in `dashboards/history/`. `layout` must fit the grid (0 ≤ x, 1 ≤ w, x+w ≤ 24, 0 ≤ y ≤ 1000, 3 ≤ h ≤ 60) or → 400; the server sets `size` from `w`. |

```ts
type Explain = {
  tileId: string; title: string; description?: string;
  measures: { name: string; table: string; description?: string; expression?: string; formatString?: string }[];
  columns:  { table: string; column: string; description?: string }[];
  filters:  { label: string; values: any[] }[];
  query: string; filterable: boolean;
};
```

## Chat

`POST /chat` **SSE** `{ modelId, question, conversationId?, filters?: FilterValue[] }`

| Event | Fields |
|---|---|
| `session` | `conversationId` |
| `stage` | `stage: "understanding" \| "running" \| "reading" \| "answering"`, `text` (e.g. "Running query"), `toolId?` |
| `thinking` | `text` (reasoning, when the model emits any) |
| `tool` | `toolId, tool, modelId?, dax?` |
| `tool_result` | `toolId, ok, rejected?, error?, rows?, truncated?, durationMs?, columns?, preview?` |
| `text` | `text` (answer delta, markdown) |
| `notice` | `text` |
| `answer_data` | `toolId, dax, columns, rows, truncated` — the last successful query of this answer, sent just before `done` |
| `done` | `usage: { provider, model, inputTokens, outputTokens, toolCalls }`, `elapsedMs` |
| `error` | `error` |

Stop = abort the fetch; the server rolls the turn back. `DELETE /chat/{conversationId}` forgets a conversation.

## Audit

`GET /audit?take=1000` → `[{ at, source: "agent"|"dashboard"|"designer"|"schema", modelId, conversationId, question, dax, rows, truncated, durationMs, rejected, error, note }]`, newest first.
