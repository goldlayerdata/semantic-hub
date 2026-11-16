# v2 UI/UX — design

_2026-11-14. Implements [v2-ui-requirements.md](v2-ui-requirements.md). Requirement ids (F1.1, N5 …) refer to that file._

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **React 18 + TypeScript + Vite**, source in `src/SemanticHub.Web/ClientApp`, built into `wwwroot/`. | Edit mode, drag-reorder, popovers, live chat state and shared chart rendering outgrow hand-written DOM code. Node 22 is already installed; the build output is static files, so the .NET app still serves everything (N1). |
| D2 | **ECharts** (bundled) replaces Chart.js. | Better default look, built-in dark theme, click events on points (needed for F7 Explain), sparklines. |
| D3 | **dnd-kit** for reorder; **Zustand** for state; no UI kit, own CSS tokens. | Small, bundled, and a custom token set gives the "modern minimal" look without fighting a component library. |
| D4 | **Tiles store a table expression, not a full query.** The server composes `EVALUATE CALCULATETABLE(<expr>, <filters>) ORDER BY …`. | This is what makes filters (F4) work on every tile without parsing arbitrary DAX, and keeps filters inside the read-only gate (N5). |
| D5 | **The browser never sends DAX.** Edits change layout fields only; new DAX comes only from the designer, the agent, or "add tile", and is validated server-side. | Keeps the lock-down rule intact: the only DAX that runs was produced or composed on the server. |
| D6 | **KPI comparison = optional second column** (`"Compare"`) in the KPI expression, e.g. `ROW("Value", [Revenue], "Compare", [Revenue PY])`. | No new spec field; the renderer shows a delta when the column is there (F3.1). |

## 2. Architecture

```
Browser (React app, bundled)                    .NET 10 minimal API                     Engines
┌────────────────────────────┐   JSON / SSE   ┌──────────────────────────────────┐
│ AppShell                    │──────────────▶│ Endpoints (Program.cs)            │
│  Sidebar · TopBar · Status  │               │  ├─ DashboardService  (new)       │
│ HubPage                     │               │  │   compose · filters · explain  │──┐
│ DashboardPage               │               │  │   pin · add-tile · layout edit │  │
│  FilterBar · TileGrid       │               │  ├─ IQaAgent (Claude | Local)     │  │
│  Tile ▸ Kpi/Chart/Table     │               │  ├─ IDashboardDesigner            │  │  HubService.RunDaxAsync
│  ExplainPopover · AddTile   │               │  └─ AuditLog                      │  ├─▶ registry → DaxGuard → limits
│ ChatPanel                   │               └──────────────────────────────────┘  │   → audit → DesktopConnector
│  ProgressSteps · Answer     │                                                      │      → msmdsrv (Power BI Desktop)
│ AuditPage                   │                                                      │
└────────────────────────────┘                     LLM: LM Studio (local) or Claude ─┘
```

Everything that touches data still ends in `HubService.RunDaxAsync`. `DashboardService` is new and owns query composition, so filters, pinning and tile edits share one code path.

## 3. Data model changes

```csharp
record DashboardSpec {
    string Title; string? Subtitle;
    List<DashboardTile> Tiles;
    List<FilterDef> Filters;              // NEW: which columns the filter bar offers
    int Version = 2;                      // NEW: v1 specs are migrated on read
    ...
}

record DashboardTile {
    string Id, Title, Kind, Format, Size, Description;
    string Expression;                    // NEW: DAX table expression, no EVALUATE / ORDER BY
    string? OrderBy;                      // NEW: e.g. "[Revenue] DESC" or "'date'[Year] ASC"
    string Origin = "designer";           // designer | pinned | added | builtin
    // Dax (v1) kept for reading old files only
}

record FilterDef(string Table, string Column, string Label);
record FilterValue(string Table, string Column, List<JsonElement> Values);   // sent by the browser
```

**v1 → v2 migration** (on read): if a tile has `Dax` but no `Expression`, split it with the same helper used for pinning (§4.3). If it can't be split (e.g. starts with `DEFINE`), keep it as a "fixed" tile: it runs unfiltered and shows a small "not filterable" hint.

## 4. Key flows

### 4.1 Filtered tile query (F4)

```
browser ── POST /dashboard/run { filters:[{table:'date',column:'Year',values:[2025]}] }
server:
  1. every filter column must exist in the cached schema (else 400)            ← no free text reaches DAX
  2. values → typed DAX literals by column data type:
       Text   → "…" with " doubled      Integer/Number → invariant number
       Date   → DATE(y,m,d)             Boolean        → TRUE()/FALSE()
  3. per filter: TREATAS({v1, v2}, 'date'[Year])
  4. per tile:   EVALUATE CALCULATETABLE(<expression>, <treatas…>) [ORDER BY <orderBy>]
  5. HubService.RunDaxAsync(...)  → DaxGuard, limits, audit as before
```

`SUMMARIZECOLUMNS`, `TOPN`, `ROW` and `VAR…RETURN` expressions all respect the outer `CALCULATETABLE` filters, so designer tiles need no special form beyond "table expression".

Filter values for the dropdowns: `GET /models/{id}/filters/values?table=&column=` → server builds `EVALUATE TOPN(500, VALUES('t'[c])) ORDER BY 't'[c]` itself (column validated against the schema).

### 4.2 Q&A progress (F5.1)

The agent loops already emit `tool`, `tool_result` and `text`. Add one event type, `stage`, emitted by the server:

| Stage | Emitted when |
|---|---|
| `understanding` | request accepted |
| `querying` | first `tool` event of a turn |
| `running` | `run_dax` starts (carries the DAX) → result fills in rows/ms |
| `answering` | first `text` delta |
| `done` / `error` / `stopped` | end |

The browser shows these as a step list with a running timer. **Stop** aborts the fetch; the server's `CancellationToken` already rolls the session back.

Active filters travel with the question (`ChatRequest.Filters`) and are added to the user turn as a short line: *"Dashboard filters in effect: Year = 2025, Category = Computers."* (F4.4)

### 4.3 Answer as chart + Pin (F5.2, F5.3)

- The server keeps the **last 10 successful `run_dax` queries per chat session** (id, DAX, columns). At `done` it emits `answer_data { toolId }` for the last one.
- The browser renders that result with the **same `ResultView` component** tiles use, picking a kind from its shape (§5.3).
- **Pin** → `POST /models/{id}/dashboard/pin { conversationId, toolId, title }`. The server looks the query up in the session (the browser never sends it), splits it into expression + order-by, validates it through the gate, and appends a tile with `Origin = "pinned"`.

Splitter: accepts `EVALUATE <expr> [ORDER BY …]` at the top level (paren/string-aware scan). Queries with `DEFINE` are pinned as "fixed" tiles (unfilterable).

### 4.4 Add a tile by request (F6.2)

```
POST /models/{id}/dashboard/tiles/suggest { request: "revenue by brand as a bar chart" }
  → IDashboardDesigner.SuggestTileAsync(model, schema, request, existing tile titles)
      (same structured output as design, but one tile; one repair round)
  → validates through the gate → returns { tile, result }      ← preview, not saved
POST /models/{id}/dashboard/tiles { suggestionId }             ← add the previewed tile
```

Suggestions are kept server-side for 15 minutes by id, so the browser confirms a suggestion rather than posting DAX (D5).

### 4.5 Edit mode (F6.1, F6.3)

`PUT /models/{id}/dashboard/layout { tiles:[{id, title, kind, size, format}], removed:[ids], filters:[FilterDef] }`
- Server merges by tile id; expressions are untouched; unknown ids are rejected.
- Undo: the browser keeps a stack of layout snapshots; Save sends the final layout; Cancel discards.

### 4.6 Explain a number (F7)

`GET /models/{id}/dashboard/tiles/{tileId}/explain?filters=…` returns:

```json
{
  "measures": [{ "name": "Revenue", "description": "…", "expression": "SUMX ( sales, … )", "format": "Currency" }],
  "columns":  ["'customer'[Country]"],
  "filters":  [{ "label": "Year", "values": [2025] }],
  "query":    "EVALUATE CALCULATETABLE( … )"
}
```

Measures and columns are found by matching `[Name]` / `'t'[c]` references in the expression against the schema (not by trusting the expression). "Ask why" pre-fills the chat with the tile, the clicked point (category + value) and the filters.

## 5. Frontend design

### 5.1 Component tree

```
App
├─ AppShell
│   ├─ Sidebar (models list w/ status dots, Hub, Audit; collapse)
│   ├─ TopBar (title, page actions, StatusChip, ThemeToggle)
│   └─ <Outlet/>
├─ HubPage
│   ├─ FirstRunGuide (3 steps, shown when hub is empty)
│   ├─ ModelCard[]  (health, counts, last read, open/add)
│   └─ DiscoveredList (+ AddModelProgress)
├─ DashboardPage
│   ├─ DashboardHeader (title, last refreshed, Refresh, Edit, Redesign)
│   ├─ FilterBar (FilterDropdown[], chips, "+ filter")
│   ├─ TileGrid (dnd-kit sortable in edit mode)
│   │   └─ Tile (menu: Explain · Ask · View query · CSV · Fullscreen · Remove)
│   │       └─ ResultView → KpiView | EChart | DataTable
│   ├─ ExplainPopover
│   ├─ AddTileDialog (request → preview → add)
│   └─ ChatPanel
│       ├─ MessageList → UserMessage | AnswerCard (text, ResultView, HowIGotThis, Pin, follow-ups)
│       ├─ ProgressSteps (stage list + timer + Stop)
│       └─ Composer + SuggestionChips
└─ AuditPage (search, facet filters, grouped by conversation, DAX highlight)
```

### 5.2 State (Zustand)

- `useHub`: models, discovered, llm status (polled every 10 s).
- `useDashboard(modelId)`: spec, tile results by id, active filters, edit mode + undo stack, last refreshed.
- `useChat(modelId)`: conversationId, messages, current run (stage, steps, elapsed), AbortController.

### 5.3 Result → visual heuristics (shared by tiles and answers)

| Shape | Kind |
|---|---|
| 1 row, 1–2 numeric cols | KPI (2nd col = comparison) |
| 1st col date or year-like, ≥ 3 rows | line (area if one series) |
| 1st col text, ≤ 8 rows, 1 series, share-like | donut |
| 1st col text, 1–3 numeric cols | bar (horizontal if > 6 rows or long labels) |
| anything else | table |

Tiles use their stored `Kind`; answers use the heuristic, and the user can switch kind before pinning.

### 5.4 Visual language

- Tokens on `:root` (light) and `[data-theme=dark]`: neutrals (`--bg`, `--surface`, `--border`, `--text`, `--muted`), one accent (indigo-blue), semantic good/bad/warn, 8-colour categorical chart palette checked for contrast in both themes.
- Type: system UI font stack (no web fonts, N1); 13 px UI, 28 px KPI numbers with tabular figures.
- Spacing 4-pt scale; radius 10 px cards, 8 px controls; 1 px borders, very soft shadows; no gradients.
- Motion: 150 ms fades for popovers, skeleton shimmer for loading tiles, nothing that delays content.
- Status chip: green dot "Local · qwen3-14b · runs on this PC" / amber "Model not loaded" / red "Not reachable".

### 5.5 Layout

- Sidebar 240 px (64 px collapsed) · content fluid · chat panel 400 px (resizable 320–560, collapsible).
- Tile grid: 12 columns; S = 3, M = 6, L = 9, Full = 12; KPI row height 120 px, charts 320 px.
- < 1280 px: chat becomes an overlay drawer; < 1024 px: sidebar collapsed by default.

## 6. API summary (new / changed)

The full contract (payloads, SSE events) is in [v2-api.md](v2-api.md). As built, a few endpoints differ from the first draft: explain and CSV export are `POST` with a `{ filters }` body (no JSON in query strings), tiles can be run one at a time so they appear progressively, and adding a model streams its steps.

| Method & path | Purpose |
|---|---|
| `GET /api/status` | + `llm.warning`, `llm.local` |
| `POST /api/models/approve` (SSE) | add a model, streaming connect → schema → profile |
| `GET /api/models/{id}/dashboard` | returns v2 spec (migrates v1 on first read) |
| `POST /api/models/{id}/dashboard/run` | body `{ filters }`; all tile results |
| `POST /api/models/{id}/dashboard/tiles/{tileId}/run` | one tile under `{ filters }` |
| `GET /api/models/{id}/filters/columns` | columns offered by "+ Filter" |
| `GET /api/models/{id}/filters/values?table=&column=` | distinct values for a filter column |
| `POST /api/models/{id}/dashboard/tiles/{tileId}/explain` | measures, columns, filters, query |
| `POST /api/models/{id}/dashboard/tiles/{tileId}/export` | CSV of a tile under `{ filters }` |
| `POST /api/models/{id}/dashboard/tiles/suggest` (SSE) | add-tile preview |
| `POST /api/models/{id}/dashboard/tiles` | add a previewed tile `{ suggestionId }` |
| `POST /api/models/{id}/dashboard/pin` | pin an answer `{ conversationId, toolId, title, kind, format }` |
| `PUT /api/models/{id}/dashboard/layout` | edit-mode save |
| `POST /api/models/{id}/dashboard/design` (SSE) | designer outputs `dax` (split server-side) + `filters` |
| `POST /api/chat` (SSE) | + `filters`; emits `stage` and `answer_data` events |

## 7. Security review (N5)

| New input | Risk | Control |
|---|---|---|
| Filter column | DAX injection via names | Must match a schema column exactly; rendered with `SchemaText.TableRef` + escaped `]`. |
| Filter values | Injection via strings | Typed literal builder; strings escape `"`; non-matching types rejected. |
| Layout edits | Smuggling DAX | Only id/title/kind/size/format accepted; expression fields ignored. |
| Pin | Pinning arbitrary DAX | Server looks up the query by session + tool id; re-validated through the gate. |
| Add tile | Same | Server-held suggestion id; DAX never round-trips through the browser. |
| Composed query | Bypassing the guard | Still passes `DaxGuard` (starts with `EVALUATE`) and the registry/limits/audit. The splitter only accepts a single top-level `EVALUATE` with balanced brackets. |
| CSV export | Formula injection in Excel | Text cells starting with `= + - @` are prefixed with `'`. |

## 8. Build & dev

- `ClientApp/` — `npm run dev` (Vite on :5173, proxies `/api` to :5080), `npm run build` → `wwwroot/`.
- The .NET project gets a `BuildClientApp` target that runs `npm ci && npm run build` on Release builds only, so `dotnet run` stays fast; built assets are committed for now to keep "clone and run" simple.
- Old `wwwroot/*.html` pages are removed once the React app reaches parity.

## 9. Implementation plan

| Step | Scope | Done when |
|---|---|---|
| 1 | Backend: v2 spec + migration, `DashboardService` (compose, filters, values), designer prompt → expression/orderBy/filters | Existing dashboard runs through composition; filters change numbers; unit tests for literal builder + splitter + compose |
| 2 | ClientApp scaffold: shell, tokens, theme, Hub page, Dashboard read-only with ECharts + skeletons | Parity with v1 pages, both themes |
| 3 | FilterBar + explain popover + tile menu (query, CSV, fullscreen) | Stories 2 and 4 pass |
| 4 | Chat panel v2: stages, timer, Stop, answer charts, How-I-got-this, Pin | Stories 3 and 6 pass |
| 5 | Edit mode + Add tile by request + undo | Story 5 passes |
| 6 | Audit page v2, first-run guide, polish pass, remove v1 pages | Story 1 passes; demo run-through |
