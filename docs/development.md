# Development

## Repository layout

```
semantic-hub/
├─ BRIEF.md, README.md, CLAUDE.md
├─ docs/                         requirements, architecture, guides, API, design history
├─ src/
│  ├─ SemanticHub.Core/          HubService (gate), DaxGuard, DaxComposer, DashboardService, HubStore, AuditLog, models
│  ├─ SemanticHub.Connectors/    DesktopConnector (discovery + ADOMD.NET)
│  ├─ SemanticHub.Agent/         prompts, tools, design validation, ChatStream, Local* and Claude* providers
│  └─ SemanticHub.Web/
│     ├─ Program.cs              endpoints, SSE, DI
│     ├─ appsettings.json        Hub limits, Llm provider, Claude options
│     ├─ wwwroot/                BUILT frontend (generated, committed)
│     └─ ClientApp/              React source
│        ├─ src/                 api.ts, types.ts, layout.ts (grid engine), stores/, components/, pages/, styles/
│        └─ mock/                server.mjs (mock API), dev.mjs (mock + Vite in one process)
└─ tests/SemanticHub.Tests/      xUnit
```

## Build, run, test

```
dotnet build                                   # whole solution
dotnet run --project src/SemanticHub.Web       # http://localhost:5080
dotnet test                                    # 83 tests
```

Frontend (Node 22):
```
cd src/SemanticHub.Web/ClientApp
npm install
npm run dev          # Vite on :5173, proxies /api to the .NET app on :5080
npm run dev:mock     # Vite on :5173 + mock API on :5090 with made-up data — no Desktop, no AI
npm run build        # type-check + build into ../wwwroot (commit the result)
```

Release builds of the web project run `npm ci && npm run build` automatically; Debug builds use the committed `wwwroot`.

## Gotchas

- **`dotnet test` does not rebuild `SemanticHub.Web`.** After backend changes, run `dotnet build src/SemanticHub.Web` before restarting the server, or the old code keeps running. A running server also locks its DLLs, so stop it before building.
- **Never test write endpoints against real hub data** (layout PUT, pin, add tile, delete, redesign). Use the unit tests or `npm run dev:mock`. Read-only checks against real data should print structure only, not data values.
- **`npm run dev:mock` runs in one process.** Stop it with Ctrl+C. If a tool stops `npm` from outside, the node process may survive, so check ports 5173 and 5090.
- **LM Studio's default context is 8192.** The schema prompt needs 16k. Empty or cut-off answers usually mean the context is too small.
- **Engine errors can be cryptic:** e.g. `Interface not implemented` usually means a DAX syntax slip such as `TOPN(n, t, [x] DESC)` instead of `TOPN(n, t, [x], DESC)`. The repair prompt adds a hint for this.

## Conventions

- **All queries go through `HubService.RunDaxAsync`.** New features compose queries in `DashboardService` / `DaxComposer` and never call a connector.
- **The browser never sends DAX.** New endpoints accept ids, filter values and display fields only.
- **Errors for users:**
  - `HubValidationException` → 400 (bad input)
  - `HubException` → 409, or 404 when `Rejected`
  - Messages are written for the user, with a next step.
- **Long operations stream SSE events.** Use `StartSse` in `Program.cs`: `progress` events, then `done` or `error`.
- **The API contract is [v2-api.md](v2-api.md).** Update it together with `ClientApp/src/types.ts` and `mock/server.mjs`.
- **Frontend:**
  - Plain CSS with tokens in `styles/tokens.css`, for both light and dark themes.
  - No UI kit, nothing loaded from the internet at runtime.
  - Charts go through `ResultView` / `EChart`, so tiles and chat answers render the same way.
  - The grid engine `layout.ts` is pure; test it in Node with `node --experimental-strip-types`.

## Tests

| File | Covers |
|---|---|
| `DaxGuardTests` | read-only guard, comment stripping |
| `HubServiceTests` | registry checks, rejection without reaching the connector, row caps, audit, rollback of failed adds |
| `DaxComposerTests` | splitter, composition, typed literals, injection attempts, hidden columns, reference matching |
| `DashboardServiceTests` | v1→v2 migration, filtered runs through the gate, layout saves (positions, bounds, explicit removal), pin, suggestions, CSV, history, chat stream stages |
| `ThinkTagFilterTests` | `<think>` handling for local models |

## Extending

- **New chart kind:** add it to `DashboardTile.Kinds`, the designer prompt and JSON schema (`AgentPrompts`), `types.ts`, and render it in `EChart.tsx`.
- **New connector** (e.g. Power BI service): implement `IModelConnector` (`Route`, `DiscoverAsync`, `ExecuteAsync`) in `SemanticHub.Connectors`, register it in `Program.cs`, and keep delegated identity (see [security.md](security.md)).
- **New AI provider:** implement `IQaAgent` and `IDashboardDesigner`, reusing `AgentTools`, `AgentPrompts` and `DesignValidation`. Add a `Llm:Provider` value and a status check in `LlmStatusAsync`.
- **Evaluations (brief phase 6):** `evals/questions.json` with questions and expected answers, plus a runner over `IQaAgent`.
