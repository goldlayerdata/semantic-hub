# v2 UI/UX — requirements

_Brainstormed 2026-11-14. Builds on [v1-local-spec.md](v1-local-spec.md). Requirements only; the design is in [v2-ui-design.md](v2-ui-design.md)._

## Goals

1. **Demo-ready.** Someone who has never seen it understands what it does in 30 seconds and trusts the numbers.
2. **Feels like a real BI + AI analyst product**, not a dev tool: one app shell, consistent visuals, no raw JSON or stack traces on screen.
3. **Hides the local model's speed** (10–30 s per answer) with visible progress, so a wait reads as "working", not "broken".

Decisions taken in the brainstorm: audience = demos to others; style = modern minimal (left sidebar, calm colours, light + dark); all four feature groups below are in.

## What's wrong today (from the v1 PoC)

| Area | Problem |
|---|---|
| Waiting | A single "Thinking…" spinner for up to a minute; looked like "doing nothing". |
| Answers | Text only; the numbers behind them are hidden in collapsed query steps. |
| Dashboard | Static: no filters, no editing, no way to see how a number was calculated. |
| Shell | Three unrelated pages with a top bar; no sense of "an app"; dark mode only by OS setting. |
| First run | No guidance: the user must know to open a .pbix, click Add, then Create dashboard. |

## Functional requirements

### F1 App shell & navigation
- F1.1 Left sidebar: model list (with online/offline dot), links to Hub, Audit, Settings; collapsible.
- F1.2 Top bar per page: page title, context actions, light/dark/system theme toggle.
- F1.3 Status chip always visible: AI provider + model, ready/not ready, "runs locally" badge when local.
- F1.4 Every async action shows progress; every error is a readable message with a next step.

### F2 Hub & first run
- F2.1 Empty state is a 3-step guide: open a .pbix in Desktop → add it → open its dashboard.
- F2.2 Model cards: name, online state, table/measure counts, description health, last schema read, dashboard yes/no.
- F2.3 Adding a model shows the steps it goes through (connect → read schema → profile data).

### F3 Dashboard
- F3.1 KPI cards with value, label and (when the model supports it) a comparison: vs previous period or a small sparkline.
- F3.2 Charts: bar, column, line, area, donut, table; consistent palette; hover tooltips; readable in both themes.
- F3.3 Tile menu: Explain, Ask about this, View query, Export CSV, Fullscreen, Remove.
- F3.4 "Last refreshed" time and a refresh action; tiles load independently with skeletons.

### F4 Filters / slicers
- F4.1 A filter bar under the title with 2–4 filters chosen from the model (e.g. Year, Category, Country).
- F4.2 Changing a filter re-runs every tile with that filter applied; active filters show as removable chips.
- F4.3 Filters are offered from the designer's choice, and the user can add/remove filters from a list of the model's columns.
- F4.4 The Q&A agent knows the active filters and uses them unless the question says otherwise.
- F4.5 Filters must still go through the read-only gate; the user can never type DAX into a filter.

### F5 Q&A panel
- F5.1 Live progress as a step list: "Understanding the question" → "Writing a query" → "Running query · 8 rows · 7 ms" → "Writing the answer", with an elapsed-seconds counter and a Stop button.
- F5.2 Answers render the result as a chart or table when the data suits it, with the text summary above.
- F5.3 "Pin to dashboard" on an answer turns its last successful query into a tile.
- F5.4 Suggested questions based on the model and the current filters; follow-up chips after an answer.
- F5.5 Each answer shows a "How I got this" section: measures used, filters, the DAX, row count.

### F6 Edit the dashboard
- F6.1 Edit mode: drag to reorder, change size (S/M/L/Full), rename, change chart type, remove.
- F6.2 "Add a tile" by typing a request ("revenue by brand as a bar chart"); the AI writes the DAX, the gate validates it, a preview appears before it's added.
- F6.3 Undo for the last change; Save/Cancel for edit mode. Changes persist to the dashboard spec.

### F7 Explain a number
- F7.1 Clicking a KPI value or chart point opens an explain card: measure name, its description, its DAX expression, filters in effect, the query that produced it.
- F7.2 "Ask why" from the explain card pre-fills the Q&A with that data point as context.

### F8 Audit
- F8.1 Search and filter by source (agent / dashboard / designer), outcome (ok / failed / blocked) and model.
- F8.2 Group agent entries by conversation; expand to see the DAX with syntax highlighting.

## Non-functional requirements

- N1 **Local-only.** No CDN or external fonts at runtime; every asset is vendored. Nothing leaves the machine in local mode.
- N2 **Perceived speed.** First paint of the dashboard < 1 s with skeletons; tile queries < 100 ms each on Desktop; progress feedback within 300 ms of any action.
- N3 **Accessibility.** Keyboard-reachable actions, visible focus, WCAG AA contrast in both themes, charts have a table alternative.
- N4 **Layout.** Designed for 1366–1920 px laptops and projectors; usable down to 1024 px; the chat panel collapses on narrow screens.
- N5 **Lock-down unchanged.** All data still flows through `HubService.RunDaxAsync`; new features (filters, pin, add tile) add no path around the guard.
- N6 **Robustness.** One failing tile never breaks the page; a model that goes offline shows a clear state, not errors on every tile.

## User stories & acceptance criteria

1. *As a presenter, I open the app on a fresh machine and get to a dashboard without help.* — Empty hub shows the 3-step guide; following it ends on a rendered dashboard.
2. *As a viewer, I filter the dashboard to 2025 and Computers.* — All tiles update within 2 s; chips show both filters; clearing them restores the totals.
3. *As a viewer, I ask "top 5 brands by revenue" and pin the answer.* — Progress steps appear immediately; the answer includes a bar chart; Pin adds a tile that survives a page reload.
4. *As a sceptic, I click the Revenue KPI.* — The explain card shows `[Revenue]`, its description, `SUMX ( sales, sales[Quantity] * sales[NetPrice] )` and the active filters.
5. *As an editor, I type "add margin % by category as a column chart".* — A preview tile appears; Add places it on the dashboard; Undo removes it.
6. *As anyone, I wait 25 s for an answer and never wonder if it's stuck.* — The step list and timer move; Stop cancels cleanly.

## Open questions

- KPI comparisons need a "previous period" definition; use the designer's choice, or a model-level setting?
- Should filters apply to pinned Q&A tiles that were created under different filters? (Proposed: tiles store their own filters; the global bar overrides on the same column.)
- Multiple dashboards per model (pages/tabs)? Proposed for later, not v2.
