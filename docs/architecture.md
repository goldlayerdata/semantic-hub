# Approach and architecture

## The approach in one paragraph

Semantic Hub treats the **semantic model as the source of truth** and the AI as a **query writer**, never as a source of numbers. A dashboard is a *spec*: a list of tiles, each holding a DAX table expression. It is not HTML or images, and every tile is run live through one gate. Questions are answered by an agent that can only call three tools (list models, read a schema, run a read-only DAX query) and must answer from the tool results. Everything (designer, tiles, filters, chat, pins) funnels through `HubService.RunDaxAsync`. That one function enforces the lock-down rules and writes the audit log, so the rules can't be bypassed by a new feature.

## Components

```
Browser: React app (bundled into wwwroot)          .NET 10 ASP.NET Core minimal API (localhost:5080)
┌──────────────────────────────────┐   JSON/SSE   ┌───────────────────────────────────────────────┐
│ Hub page        (models, add)    │─────────────▶│ Program.cs endpoints                          │
│ Dashboard page                   │              │  ├─ DashboardService  compose · filters ·     │
│  FilterBar · DashboardCanvas     │              │  │    explain · pin · add tile · layout · CSV │
│  Tile ▸ ResultView (ECharts)     │              │  ├─ IDashboardDesigner (Local | Claude)       │
│  ExplainPanel · AddTileDialog    │              │  ├─ IQaAgent          (Local | Claude)        │
│ ChatPanel (steps, answers, pin)  │              │  │    └─ AgentTools: list_models,              │
│ Audit page                       │              │  │       get_schema, run_dax                   │
└──────────────────────────────────┘              │  └─ HubService ◀── every query goes here      │
                                                  │       registry → DaxGuard → limits → audit    │
                                                  │       └─ IModelConnector                       │
                                                  │            └─ DesktopConnector (ADOMD.NET)    │
                                                  └─────────────────┬─────────────────────────────┘
                     LM Studio (localhost:1234, OpenAI API) ◀───────┤
                     or Anthropic API (optional)                    ▼
                                                  Power BI Desktop · msmdsrv.exe (localhost:<port>)
```

### Projects

| Project | Role |
|---|---|
| `SemanticHub.Core` | Hub registry and store (`HubStore`), schema model, `HubService` (the gate), `DaxGuard`, `DaxComposer` (filters + query composition), `DashboardService`, dashboard spec + built-in layout (`HeuristicDashboard`), `AuditLog` |
| `SemanticHub.Connectors` | `DesktopConnector`: finds open Desktop files (WMI → `msmdsrv.exe` → port), runs DAX via ADOMD.NET with a row cap and timeout, normalises values (dates → ISO strings) |
| `SemanticHub.Agent` | Prompts, the three tools, design validation/repair, chat stream wrapper (`ChatStream`), and two providers: `LocalQaAgent`/`LocalDashboardDesigner` (Microsoft.Extensions.AI → OpenAI-compatible server) and `ClaudeQaAgent`/`ClaudeDashboardDesigner` (Anthropic SDK) |
| `SemanticHub.Web` | Minimal API endpoints, SSE streaming, DI wiring, serves the built React app from `wwwroot` |
| `SemanticHub.Web/ClientApp` | React 18 + TypeScript + Vite; ECharts; dnd-kit; Zustand. Built into `wwwroot` |
| `tests/SemanticHub.Tests` | xUnit: guard, gate, composer, dashboard service, chat stream, think-tag filter |

## Key flows

### 1. Adding a model
`POST /api/models/approve` (SSE) runs four steps:
1. Discovery matches the open `.pbix`.
2. The model is registered in `hub.json`.
3. The schema is read with `INFO.VIEW.TABLES/COLUMNS/MEASURES/RELATIONSHIPS()`.
4. A short data profile is taken (row counts, the date range of each fact table, so the AI doesn't assume "last year" exists in historical data).

If the schema read fails, the registration is rolled back.

### 2. Designing a dashboard
1. The designer gets the schema as text and returns a JSON spec (constrained by a JSON schema): tiles with `dax`, kind, format and size, plus 2–4 filter columns.
2. Each tile's query is split into **expression + ORDER BY** (`DaxComposer.Split`) and **run through the gate** to validate it. A KPI must return exactly one row, a chart needs a category column plus a value column, and so on.
3. Failing tiles get **one repair round**, with the engine's error message sent back to the AI. Tiles that still fail are dropped and listed.
4. If no AI is available, `HeuristicDashboard` builds a sensible layout from the schema instead: KPIs from the first measures, a yearly trend, and top-10 breakdowns by dimension columns.

### 3. Running a tile with filters
A tile never stores a full query. The server composes one per run:

```
EVALUATE
CALCULATETABLE(
    <tile expression>,
    TREATAS({2025}, 'date'[Year]),
    TREATAS({"Audio", "Phones"}, 'product'[Category])
)
ORDER BY <tile order-by>
```

- **Filter columns** must exactly match a visible schema column.
- **Filter values** become typed DAX literals (text escaped, integers, numbers, `DATE()`, `TRUE()`, `BLANK()`), so no browser text is ever pasted into DAX as code.
- **Fixed tiles:** queries that can't be split (e.g. they use `DEFINE`) run unfiltered and are marked as such.

### 4. Answering a question
1. `POST /api/chat` (SSE) adds the active filters to the question as a short note, including their DAX form.
2. The agent loop:
   - The model calls `run_dax`.
   - The gate runs the query.
   - The result goes back to the model.
   - This repeats until the model answers, or the tool limit takes the tools away.
3. `ChatStream` turns raw events into UI **stages**: understanding → running query (rows, ms) → reading results → writing the answer.
4. It remembers the successful queries on the session and sends `answer_data` (the last result) so the UI can draw a chart.
5. **Stop** aborts the request, and the server rolls the turn back.

### 5. Pinning and adding tiles (without the browser sending DAX)
- **Pin:** the browser sends `{ conversationId, toolId }`. The server looks the query up in the chat session, splits it, validates it and appends the tile.
- **Add tile:** the AI drafts a tile, the server validates it and keeps it under a `suggestionId` for 15 minutes, and the browser previews the result. "Add" sends only the id.

### 6. Arranging (v3)
- **Grid:** each tile has `layout { x, y, w, h }` on a 24-column grid.
- **Engine:** the frontend's pure engine (`ClientApp/src/layout.ts`) handles drag, resize, push-down, row reorder and vertical compaction.
- **Saving:** changes are saved after 800 ms through `PUT /dashboard/layout`. That accepts only display fields: id, title, kind, format, size and layout.
- **Deleting is explicit:** tiles not listed are kept, and only ids in `removed` are deleted. Every save first copies the previous version to `dashboards/history/`.

## Design decisions

| Decision | Why |
|---|---|
| Desktop first, via ADOMD.NET to localhost | No tenant setup, no licence; works with any `.pbix` |
| One gate (`HubService.RunDaxAsync`) for all queries | Lock-down is enforced in one place and every new feature gets it for free |
| Dashboards as a spec of DAX expressions, not generated HTML | Every number is live and auditable; the same spec drives filters, explain and CSV |
| Tiles store expressions; the server composes filters with `TREATAS` | Filters work on every tile without parsing arbitrary DAX, and stay inside the gate |
| The browser never sends DAX | Pins and added tiles go by server-held ids; layout saves carry display fields only |
| Local LLM by default (LM Studio + Qwen3 14B) | Free, and nothing about the model or its data leaves the PC |
| Provider switch (local / Claude) behind two interfaces | Same tools, prompts and validation; only the client differs |
| Validate every AI tile against the engine, with one repair round | Small local models write imperfect DAX; the engine is the judge |
| Minimal API + React SPA built into `wwwroot` | `dotnet run` needs no Node at runtime; rich interactions (grid, chat state) need a real UI framework |
| Own grid engine on dnd-kit (no grid library) | No extra dependency; keyboard dragging comes from dnd-kit |
| Server-sent events for long operations | Design, add tile, approve and chat stream progress so slow local models still feel alive |
| Deletes must be explicit + automatic history | A stale browser tab must never be able to wipe tiles by omission |

## Where the rules live

| Rule (from the brief) | Code |
|---|---|
| Read-only | `DaxGuard.Check`: query must start with `EVALUATE`/`DEFINE` after comments are stripped; length and null checks |
| Registered models only | `HubService.RunDaxAsync` looks the id up in `hub.json`; tools take a hub id, never a connection string |
| Limits | `HubOptions` (rows, timeout, tool calls); the connector caps rows; the agent loop enforces the tool limit |
| Grounded answers | `AgentPrompts.Qa` |
| Audit log | `AuditLog`: written by the gate for every query, including rejected ones |
| Identity | Desktop runs as the signed-in Windows user. The service connector (not built) must use delegated sign-in |

See [security.md](security.md) for the threat model.
