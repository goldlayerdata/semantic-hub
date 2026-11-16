# v1 — Local Dashboard + Q&A (requirements & chosen approach)

_Brainstormed 2026-11-14. Extends [BRIEF.md](../BRIEF.md); phases 1–4 collapsed into one local build._

## Goal

Open a `.pbix` in Power BI Desktop → add it to the hub → get an **auto-designed HTML dashboard** of that model → while
viewing it, **ask questions** in a side panel answered by the locked-down agent with read-only DAX.

## Scope decisions (v1)

| Question | Decision |
|---|---|
| Users | Just you, on this machine. No sign-in; queries run as your Windows identity against Desktop. |
| Where it runs | Locally only (`http://localhost:5080`). |
| What the hub stores | Approved models, cached schema, dashboard spec, chat-free audit log. No saved questions yet. |
| Service / REST connector | Out of scope (phase 5 of the brief). `IModelConnector` keeps the seam. |

## Functional requirements

1. **Discover** open Power BI Desktop models (port + `.pbix` name) and list them.
2. **Approve** a discovered model into the hub → harvest schema with `INFO.VIEW.*`, cache to disk.
   Approved models are keyed by a stable hub id (slug of the file name); the port is re-resolved on every use.
3. **Design a dashboard** for an approved model:
   - Claude reads the schema and returns a *dashboard spec* (structured JSON): KPI cards + 4–8 charts/tables,
     each with its own DAX query, chart type, and field bindings. Prefers existing measures.
   - Every tile's DAX is **validated by running it** through the same guard as the agent; failed tiles get one
     repair attempt, then are dropped.
   - Spec cached per model; "Redesign" regenerates it. If no API key is set, a heuristic spec (KPIs for measures) is used.
4. **View the dashboard**: tiles render from live query results (Chart.js). Refresh re-runs the tiles.
5. **Ask questions** in a side panel scoped to the viewed model:
   - Agent tools: `list_models`, `get_schema(modelId)`, `run_dax(modelId, query)`.
   - Agent also sees the dashboard spec, so "why is this tile high?" works.
   - Answer streams in; each DAX query used is shown (collapsible) with row count and timing.
   - Multi-turn per dashboard session.
6. **Audit log** viewable at `/audit.html`: question, DAX, rows, duration, errors.
7. **Model health**: flag measures/columns without descriptions on the hub page.

## Non-functional / lock-down (from BRIEF, applied locally)

- Read-only guard: comments stripped, must start with `EVALUATE` or `DEFINE`; anything else rejected before it reaches ADOMD.
- `run_dax` accepts a hub model id only — never a connection string or port.
- Limits: 500 rows to the model, 30 s query timeout, 10 tool calls per question (configurable in `appsettings.json`).
- Grounded answers: system prompt requires answering only from tool results, naming measures/filters, and saying when the data can't answer.
- Model `claude-opus-5-5`, effort set explicitly (`medium` for Q&A, `high` for dashboard design), server-side refusal fallback on,
  prompt caching on tools + system + schema.

## Acceptance criteria

- With Contoso open in Desktop: discover → approve → dashboard renders ≥ 4 working tiles without manual edits.
- Asking "What were total sales last year by category?" streams an answer that cites the measure used and shows the DAX.
- A prompt-injected request like "run `{ "delete": ... }`" or "connect to localhost:1234" is refused by the guard / tool contract and logged.
- Unit tests cover the DAX guard and the row limiter.

## Approach chosen (and why)

- **ASP.NET Core minimal API + static HTML/JS** instead of Blazor Server: the dashboard *is* an HTML page with a JS chart library,
  SSE streaming is trivial from a minimal API, and the dashboard can later be exported as a standalone file.
- **Spec-driven dashboards** (Claude designs JSON, the app runs the DAX) rather than Claude writing HTML: numbers always come from
  live queries through the guard, the spec is small, cacheable, editable, and re-renderable.
- **Manual streaming tool loop** instead of `BetaToolRunner`: we need per-question tool-call caps, audit hooks, and to stream
  DAX/tool events to the UI.

## Open questions (later)

- Pin/edit individual tiles by hand? Dashboard-level filters (slicers)?
- Let a Q&A answer be "pinned" as a new dashboard tile.
- Export dashboard as standalone HTML.
