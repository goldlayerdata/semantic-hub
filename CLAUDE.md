# Semantic Hub

.NET app: hub of Power BI semantic models + an HTML dashboard per model + a locked-down Claude agent that answers questions with read-only DAX.

- Read [BRIEF.md](BRIEF.md) first — goal, decisions, architecture, lock-down rules, phases.
- [README.md](README.md) and [docs/](docs/): requirements, architecture, user guide, security, development (gotchas!), troubleshooting, API reference.
- [docs/v1-local-spec.md](docs/v1-local-spec.md) — what the local v1 does and why.
- [docs/v2-ui-requirements.md](docs/v2-ui-requirements.md), [docs/v2-ui-design.md](docs/v2-ui-design.md), [docs/v2-api.md](docs/v2-api.md) — the v2 UI: requirements, design, and the API contract between the React app and the backend.
- [docs/v3-ui-design.md](docs/v3-ui-design.md) — v3: free 24-column grid layout (drag/resize, autosave, lock) and visual polish.
- The lock-down rules in the brief are non-negotiable. All model data goes through `HubService.RunDaxAsync` (registry → `DaxGuard` → limits → audit); never call a connector directly from the agent or web layer.
- Use the `claude-api` skill before writing Anthropic SDK code.

## Run

```
dotnet run --project src/SemanticHub.Web     # http://localhost:5080 — needs a .pbix open in Power BI Desktop
dotnet test
```

Frontend: React + TS + Vite in `src/SemanticHub.Web/ClientApp`, built into `wwwroot/` (committed, so `dotnet run` needs no Node). After changing it: `cd src/SemanticHub.Web/ClientApp && npm run build`. Dev loop: `npm run dev` (Vite on :5173, proxies `/api` to :5080). UI work without Desktop or real data: `npm run dev:mock` (made-up retail data from `mock/server.mjs` on :5090). The grid engine is the pure `src/layout.ts`. Release builds run `npm ci && npm run build` automatically.

Dashboard tiles store a DAX table expression; `DaxComposer` wraps it with the filter bar's `TREATAS` filters and `DashboardService` runs it through the gate. The browser never sends DAX (pin/add-tile go by server-held ids, layout edits touch display fields only).

`Llm:Provider` in `src/SemanticHub.Web/appsettings.json` picks who designs dashboards and answers questions in this app:
- `"local"` (current default): an OpenAI-compatible server, LM Studio at `http://localhost:1234/v1`. Empty `LocalModel` = first model the server lists. Load the model with a context length of 16k+ (the schema prompt is ~5–8k tokens).
- `"claude"`: Anthropic API, needs a valid `ANTHROPIC_API_KEY`.

If the provider isn't reachable, dashboards use the built-in layout (`HeuristicDashboard`) and chat reports the problem. Both providers share `AgentTools` (the three tools), `AgentPrompts` and `DesignValidation`; Claude-only extras (prompt caching, refusal fallbacks, adaptive thinking) live in `ClaudeQaAgent`/`ClaudeDashboardDesigner`.

Hub data (registry, schemas, dashboards, audit log) lives in `%LOCALAPPDATA%\SemanticHub`.

## Status (2026-11-16)

- v1 verified against a live Desktop model: discovery, approve, schema harvest + profile, dashboards, audit, local Qwen3 14B Q&A.
- v2 UI built: app shell, first-run guide, filters, explain, tile menu/CSV, chat with live steps + chart answers + pin, add tile, audit v2. Used live by the user (designer with filters, tiles, filter values, chat follow-up).
- v3 built and checked on the mock: drag tiles by their title, resize from the corner, row reorder / push-down / compaction, autosave + Undo, Lock layout, Arrange menu (keyboard), Edit-tile popover, currency symbols, KPI alignment, breadcrumb, chat start screen. Used live on the Contoso sample for the demo recording (2026-11-16); the owner signed off the PoC as successful.
- Known gap: on a model with 0 measures the built-in fallback layout (`HeuristicDashboard`) produces no tiles; the AI designer copes by aggregating columns.
- 83 unit tests pass. Layout saves delete only ids in `removed` (never by omission); each dashboard save keeps a history copy. The Claude provider is experimental and deliberately left untested (owner decision 2026-11-16); local is the supported provider.
- Never test write endpoints against the user's real hub data — use unit tests or the mock (a test PUT once wiped tiles; restored from the audit log).
- Proposed next: a hub-level chat that can ask across any online model.
- Not started: phase 5 (`RestConnector` + MSAL), phase 6 (evals).
