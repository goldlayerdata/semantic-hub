# Security and lock-down

Semantic Hub lets an AI query your data, so the controls sit in code, not in the prompt. The rules come from the [brief](../BRIEF.md) and are non-negotiable.

## The rules and how they're enforced

| # | Rule | Enforcement |
|---|---|---|
| 1 | **Read-only** | `DaxGuard.Check` strips comments (aware of strings and quoted names) and accepts only queries starting with `EVALUATE` or `DEFINE` (a `DEFINE` must contain `EVALUATE`), at most 20,000 characters, with no null characters. XMLA/TMSL commands, DMVs and MDX never pass. The guard is the second line of defence; the connecting identity's own rights are the first. |
| 2 | **Registered models only** | `run_dax` and every endpoint take a hub model id. `HubService.RunDaxAsync` rejects ids not in `hub.json` before anything reaches a connector. Connection strings and ports are never exposed to the AI or the browser. |
| 3 | **Limits** | Rows per query (500; tiles 200), query timeout (30 s), tool calls per question (10). Past the tool limit, the local agent loses its tools and must answer. |
| 4 | **Grounded answers** | The system prompt requires numbers to come from tool results in this conversation, naming the measure and filters, and saying so when the data can't answer. Text inside data is treated as data, never instructions. |
| 5 | **Audit** | The gate logs every query (ok, failed and rejected) with source, conversation, question, DAX, rows and duration to `audit/audit-YYYY-MM-DD.jsonl`. |
| 6 | **Identity** | Desktop models run under the signed-in Windows user. The future service connector must use delegated sign-in (MSAL) so row-level security and workspace permissions apply, never a service account. |

**The one-gate principle:** dashboards, the designer, filters, explain, CSV export, pin, add tile and the chat agent all run queries **only** through `HubService.RunDaxAsync`. Nothing calls a connector directly.

## The browser never sends DAX

| Browser input | Risk | Control |
|---|---|---|
| Filter column | DAX injection through a name | Must match a visible schema column (case-insensitive); rendered from the schema's own names with quotes and brackets escaped |
| Filter values | Injection through strings | Converted to typed literals by column type (text escaped, integers, numbers, `DATE()`, `TRUE()`/`FALSE()`, `BLANK()`); values that don't fit the type are rejected (400). Max 8 filters, 200 values each |
| Layout save | Smuggling queries | Only id, title, kind, format, size and grid position are accepted; expressions can't be changed; positions are bounds-checked |
| Pin | Pinning arbitrary DAX | The server looks the query up in the chat session by tool id, re-splits it and re-validates it through the gate |
| Add tile | Same | The AI's tile is held server-side by `suggestionId` for 15 minutes; the browser only confirms the id |
| Composed tile query | Escaping the wrapper | The splitter accepts only a single top-level `EVALUATE` with balanced brackets; the composed query still passes `DaxGuard` |
| CSV export | Spreadsheet formula injection | Text cells starting with `= + - @` are prefixed with `'` |
| Chat text | Script injection through AI markdown | Rendered with `marked` and sanitised with DOMPurify |

## Data protection

- **Local provider (default):** schema, questions, queries and results go only between the app, Power BI Desktop and LM Studio on `localhost`. No telemetry, no CDN, no web fonts.
- **Claude provider:** the schema, questions and query results are sent to the Anthropic API. Use it only for models whose data may leave the PC.
- **What's stored:** schema and data profile, dashboard specs (with 20 history versions each) and the audit log, all under `%LOCALAPPDATA%\SemanticHub`. Query results are not stored; chat sessions live in memory for 4 hours.
- **The server listens on localhost only** (`Urls: http://localhost:5080`, `AllowedHosts: localhost;127.0.0.1`). There is no authentication, so **don't expose it on a network** as-is.

## Data safety

- Dashboard layout saves never delete tiles by omission: deletes must be listed explicitly (`removed`).
- Every dashboard save first copies the previous version to `dashboards/history/{id}/` (the last 20 are kept). To restore one, copy it over `dashboards/{id}.json`.

## Known issues and follow-ups

| Item | Status |
|---|---|
| npm advisories (DOMPurify XSS, React Router open redirects, ECharts XSS, Vite/esbuild dev-server issues) | **All fixed 2026-11-16**: DOMPurify 3.4.18, React Router 7.18.5, ECharts 6.1.0, Vite 6.4.6. `npm audit`: 0 vulnerabilities; `dotnet list package --vulnerable`: none |
| Keep it that way | Run `npm audit` (in `ClientApp`) and `dotnet list package --vulnerable --include-transitive` before each release |
| No authentication on the API | By design for a single-user local app; needed before any shared or hosted use |
| Claude provider not tested end to end | Open |
| Service connector (REST + MSAL delegated) | Not built; must keep rules 1–6 |
