# Semantic Hub — Project Brief

_Created 2026-11-14. Starting point for the first build session in this workspace._

## Goal

A .NET app that:

1. **Connects** to Power BI semantic models (local Power BI Desktop first, Power BI service later).
2. **Builds a hub** — a registry of approved models with a cached schema per model (tables, columns, measures, descriptions, relationships).
3. **Runs a locked-down AI agent** (Claude) that answers natural-language questions about the data by writing and running read-only DAX against the hub's models — and nothing else.

## Decisions already made

| Topic | Decision |
|---|---|
| Stack | .NET 10 (SDK 10.0.404 installed), ASP.NET Core API + simple chat UI (Blazor Server unless there's a reason not to) |
| First connection route | **Local Power BI Desktop** via ADOMD.NET to `localhost:<port>` — no tenant setup needed |
| Second route (phase 2) | **REST `executeQueries`** against the Power BI service (works on Pro; tenant setting must allow it; ~100k rows/query, ~120 queries/min/user) |
| Later (optional) | XMLA endpoint (needs Premium / PPU / Fabric capacity) for larger results and full TOM metadata |
| LLM | Official `Anthropic` NuGet package, model `claude-opus-5-5` |
| Repo | Own local git repo, private. Kept separate from any public site/repo folders. |

## Architecture

```
┌──────────── Semantic Hub (.NET) ─────────────────────────────┐
│                                                              │
│  Hub registry              Agent (Anthropic SDK)             │
│  - model id, name,         tools:                            │
│    connection route          list_models()                   │
│  - cached schema             get_schema(modelId)             │
│  - who may see it            run_dax(modelId, query)         │
│                                                              │
│  IModelConnector                                             │
│   ├─ DesktopConnector  (ADOMD → localhost:<port>)  phase 1   │
│   └─ RestConnector     (executeQueries + MSAL)     phase 2   │
└──────────────────────────────────────────────────────────────┘
```

Suggested solution layout (adjust if a better one emerges):

```
src/
  SemanticHub.Core/        # hub registry, schema model, IModelConnector, DAX guard
  SemanticHub.Connectors/  # DesktopConnector, RestConnector
  SemanticHub.Agent/       # Claude tool definitions + agent loop
  SemanticHub.Web/         # ASP.NET Core API + chat UI
tests/
  SemanticHub.Tests/
evals/
  questions.json           # question → expected answer pairs
```

## Connecting

- **Desktop:** find the running `msmdsrv.exe` port (from the workspace folder's `msmdsrv.port.txt` under the Power BI Desktop AnalysisServicesWorkspaces folder, or by process/netstat), then connect with `Microsoft.AnalysisServices.AdomdClient`. Multiple open Desktop files = multiple models in the hub.
- **Schema harvest:** run `EVALUATE INFO.VIEW.TABLES()`, `INFO.VIEW.COLUMNS()`, `INFO.VIEW.MEASURES()`, `INFO.VIEW.RELATIONSHIPS()` and cache the result per model. Refresh on demand.
- **REST (phase 2):** `POST https://api.powerbi.com/v1.0/myorg/groups/{workspaceId}/datasets/{datasetId}/executeQueries`, token via MSAL with delegated (signed-in user) auth.

## Lock-down rules (non-negotiable)

1. **Identity:** run queries as the signed-in user (delegated / on-behalf-of), never a broad service account — so RLS and workspace permissions apply.
2. **Read-only:** only accept queries that start with `EVALUATE` or `DEFINE`; the connecting identity gets Read/Build only (XMLA can carry TMSL write commands, so the permission matters, not just the guard).
3. **Registered models only:** `run_dax` takes a hub model id, never a connection string or server name.
4. **Limits:** max rows returned to the model (start at 500), query timeout (start at 30 s), max tool calls per question (start at 10).
5. **Grounded answers:** system prompt says answer only from tool results, name the measure/filters used, and say so when the data can't answer the question.
6. **Audit log:** every question, generated DAX, row count and duration is logged.

## Agent notes (Anthropic C# SDK, verified 2026-11-14)

- `dotnet add package Anthropic`; tool loop via `client.Beta.Messages.ToolRunner(...)` with raw JSON-schema tools (or `Microsoft.Extensions.AI` `IChatClient` integration).
- Model `claude-opus-5-5`: thinking is adaptive and can't be disabled; control depth with `output_config.effort` (default is `medium` — set it explicitly). Forced `tool_choice` (`any`/`tool`) returns 400 — use `auto` + `strict: true` tools.
- Enable server-side refusal fallbacks (`server-side-fallback-2026-07-01` beta, `fallbacks: "default"`).
- Stream responses in the chat UI.
- Use prompt caching: tools + system prompt + the selected model's schema are stable — put them first.
- Before writing SDK code, check the C# docs in the `claude-api` skill; don't guess type names.

## What drives answer quality

- **Measure and column descriptions** in the semantic model matter more than the code. Flag models with missing descriptions in the hub UI.
- Prefer **existing measures** over raw aggregation so numbers match the reports.
- Keep an **eval set** (`evals/questions.json`, ~20 questions with known answers) and run it after any prompt/model change.

## Test data

A sample retail model (PBIX, e.g. a Contoso sample) — open it in Power BI Desktop and use it as the first hub model.

## Phases

1. **Spike** — console app: connect to an open Desktop model, harvest schema, run one DAX query.
2. **Hub** — registry + schema cache + `IModelConnector`; list several open Desktop models.
3. **Agent** — Claude with the three tools, DAX guard, limits; answer questions in a console loop.
4. **Web** — ASP.NET Core API + chat UI with streaming and the audit log.
5. **Service** — `RestConnector` + MSAL delegated sign-in; models from Power BI workspaces.
6. **Evals** — question set and a runner; tune the prompt.

## Open questions

- Who are the users — just you, or clients/team members (affects auth and multi-tenancy)?
- Where does it run — locally only, or hosted (Azure App Service, etc.)?
- Should the hub store anything beyond schema (saved questions, favourite answers)?
- Built-in alternatives to compare against: Fabric data agents, Copilot in Power BI.
