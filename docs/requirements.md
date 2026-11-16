# What Semantic Hub needs

Everything runs on one Windows PC. The app talks to Power BI Desktop and to a local AI server, both on `localhost`.

## At a glance

| Need | Minimum | Tested with |
|---|---|---|
| OS | Windows 10/11 x64 (Power BI Desktop is Windows-only) | Windows 11 |
| Power BI Desktop | A version that supports the `INFO.VIEW.*` DAX functions (2024 or later) | 2.159 (Oct 2026) |
| .NET | .NET 10 SDK to build and run (the runtime alone is enough for a published build) | SDK 10.0.404 |
| Local AI server | LM Studio, or any OpenAI-compatible server | LM Studio 0.4.28 |
| AI model | A chat model with tool calling and JSON-schema output, 14B or larger recommended | Qwen3 14B, Q4_K_M (8.4 GB file) |
| GPU / memory | About 10 GB VRAM for a 14B Q4 model with 16k context, plus 16 GB system RAM | A 12 GB GPU (Vulkan), 16 GB RAM, 6-core CPU |
| Disk | About 10 GB for the model, under 50 MB for the app and its data | |
| Node.js | Only to change the frontend (not needed to run it) | Node 22.23, npm 10.8 |
| Browser | A current Chrome, Edge or Firefox | Chrome |

## Power BI

- **Power BI Desktop with the model open.** The app reads the model through Desktop's built-in Analysis Services engine (`msmdsrv.exe`) on a localhost port it discovers itself. When the `.pbix` is closed, the model shows **offline** and no queries run.
- **No Power BI licence, tenant or workspace** is needed for Desktop models.
- **Good descriptions matter more than code.** Answer quality depends on measure, column and table descriptions in the model, and the hub shows the coverage per model. Prefer explicit measures (e.g. `[Revenue]`) over implicit aggregation.
- **Optional:** a previous-period measure such as `[Revenue PY]` lets KPI cards show a comparison.
- **Later (not built):** models in the Power BI service via the REST `executeQueries` API. That will need a Pro licence, the tenant setting for dataset queries, and signing in with your own account.

## AI model (local, the default)

`Llm:Provider = "local"` in `src/SemanticHub.Web/appsettings.json`.

| Setting | Value | Why |
|---|---|---|
| Server | LM Studio → Developer tab → **Start Server** on `http://localhost:1234` | The app uses the OpenAI-compatible `/v1` API |
| Model | `qwen/qwen3-14b` (or set `Llm:LocalModel`; empty = first model the server lists) | Reliable tool calls and JSON output at this size |
| **Context length** | **16384 or more** when loading the model | The schema prompt alone is 5–8k tokens. With LM Studio's default of 8192, answers come back empty or cut off |
| Thinking | Off (the app appends `/no_think` for Qwen3) | With thinking on, each answer took about a minute |
| GPU offload | Max | On a 12 GB GPU: ~17 tokens/s, ~8.4 GB VRAM |

What to expect on comparable hardware:
- A question takes **10–30 s**: about 3–5 s per query step plus writing the answer.
- A full dashboard design takes **1–2 min**.

The UI shows live progress, so waits read as "working".

Smaller models (7–8B) work but write wrong DAX more often. The designer drops tiles that fail validation, and chat answers retry more.

**Command line (optional):**
```
%USERPROFILE%\.lmstudio\bin\lms.exe server start
%USERPROFILE%\.lmstudio\bin\lms.exe load qwen/qwen3-14b --context-length 16384 --gpu max --yes
```
The `lms` CLI needs the LM Studio app to be running.

## AI model (Claude, optional)

`Llm:Provider = "claude"` plus an `ANTHROPIC_API_KEY` environment variable. The model is `claude-opus-5-5` (`Claude:Model`).
- **Data leaves the PC:** schema and query results are sent to the Anthropic API.
- **Not yet tested end to end.**

## Network and ports

| Port | What | Exposed? |
|---|---|---|
| 5080 | Semantic Hub (`Urls` in appsettings) | localhost only (`AllowedHosts: localhost;127.0.0.1`) |
| 1234 | LM Studio server | localhost |
| dynamic | Power BI Desktop's Analysis Services | localhost, discovered automatically |
| 5173 / 5090 | Frontend dev server / mock API (development only) | localhost |

With the local provider there is **no outbound traffic** at runtime: all frontend assets are bundled, with no CDN or web fonts. Internet is only needed to install things: NuGet and npm packages, and the model download.

## Permissions

- **Normal user rights.** The app finds Desktop through WMI process information (falling back to Desktop's port files) and connects to the engine on localhost; no admin rights needed.
- **Your own access.** Desktop models run under your own Windows account, so you only see what you can already see in Desktop.

## Data the app stores

Under `%LOCALAPPDATA%\SemanticHub` (change with `Hub:DataDirectory`):

| Path | Contents |
|---|---|
| `hub.json` | Registered models (id, name, `.pbix` path) |
| `schemas/{id}.json` | Cached schema and data profile (row counts, date ranges) |
| `dashboards/{id}.json` | Dashboard spec: tiles (DAX expression, kind, format, grid position), filters |
| `dashboards/history/{id}/` | The last 20 previous versions of each dashboard (automatic) |
| `audit/audit-YYYY-MM-DD.jsonl` | One line per query: source, question, DAX, rows, duration, errors |

Query **results are not stored**; they only exist in memory and in the browser. Chat conversations are kept in server memory for 4 hours.

## Limits (configurable under `Hub` in appsettings)

| Setting | Default |
|---|---|
| `MaxRows` returned per query | 500 (dashboard tiles: 200) |
| `QueryTimeoutSeconds` | 30 |
| `MaxToolCallsPerQuestion` | 10 |
