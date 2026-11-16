# v3 UI — free layout + polish

_2026-11-15. Builds on [v2-ui-design.md](v2-ui-design.md). Reviewed against the v2 app running on the mock API (`npm run dev:mock`, made-up retail data; no real model data was used)._

## 1. Review of v2 (what to fix)

| # | Finding | Effect |
|---|---|---|
| R1 | Tiles flow in a fixed order with 4 widths (S/M/L/Full); heights are fixed per kind. | You can't put a chart where you want it, make a chart taller, or put two KPIs next to a donut. |
| R2 | Moving and sizing is only possible in Edit mode, and Edit mode puts size/kind/format controls on every tile at once. | Busy, slow to arrange; the dashboard doesn't look like itself while editing. |
| R3 | Currency values have no symbol (`17.57M`). | Reads like a count; KPIs look unfinished. |
| R4 | A KPI without a comparison has its value lower than its neighbours. | Uneven KPI row. |
| R5 | Model name appears in the top bar and again as the dashboard title. | Wasted space, unclear hierarchy. |
| R6 | Cards and canvas are close in tone (dark mode especially). | Tiles don't separate clearly. |
| R7 | Chat empty state is three plain chips. | Weak first impression in a demo. |

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Grid canvas: 24 columns, 24 px rows, 12 px gaps.** Each tile has `layout { x, y, w, h }` in grid units. | Fine enough to place freely, coarse enough to stay aligned. |
| D2 | **Vertical compaction** (tiles float up, no holes); dropping onto a tile pushes it down. | Like Grafana. A free canvas with holes (Power BI style) looks broken when tiles are removed, and doesn't reflow for smaller screens. |
| D3 | **Always-on arranging, no Edit mode.** Drag a tile by its header; resize with the corner handle shown on hover; changes save automatically (debounced) with an Undo toast. A **Lock layout** toggle stops accidental moves during demos. | Direct manipulation is the expected BI behaviour; removes R2. |
| D4 | **Own layout engine on dnd-kit** (already installed): a pure `layout.ts` (move, resize, collide, compact) + dnd-kit for pointer and keyboard drag. | No new dependency to download; dnd-kit's keyboard sensor gives keyboard moving for free (N3). |
| D5 | **Tile settings in a popover** (tile menu → Edit tile: title, chart type, number format) instead of inline controls. Remove stays in the menu. Add tile stays in the header. | Keeps tiles clean (R2). |
| D6 | **Keyboard / accessible arrange:** tile menu → Arrange: move left/right/up/down, wider/narrower, taller/shorter. Drag handle also works with Space + arrow keys. | Mouse-free fallback for the grid (N3). |
| D7 | **Narrow screens (< 900 px content):** single column, read-only order by (y, x); arranging is disabled with a hint. | The 24-column layout can't fit; never save a squeezed layout. |
| D8 | **Currency symbol per model**: the server derives it from the measures' format strings (most common of `$ € £ ¥ kr R` …) and sends `spec.currency`. | Fixes R3 without asking the LLM. |

## 3. Data model

```csharp
record TileLayout(int X, int Y, int W, int H);       // grid units
record DashboardTile { …; TileLayout? Layout; }       // null = place automatically
record DashboardSpec { …; string? Currency; }         // e.g. "$"; computed on read, not stored
```

- `Size` stays for old specs and narrow screens; when a layout is saved the server sets `Size` from `W` (≤ 6 small, ≤ 12 medium, ≤ 18 large, else full).
- **Auto placement** (client, when any tile lacks a layout): flow tiles in spec order: width from size (S=6, M=12, L=18, Full=24), height from kind (KPI 5 rows ≈ 140 px, table 12, charts 11), then compact. New tiles (pinned/added) have no layout and land at the bottom.
- **Layout PUT** accepts `layout` per tile. Server bounds: `0 ≤ x`, `1 ≤ w`, `x + w ≤ 24`, `0 ≤ y ≤ 1000`, `3 ≤ h ≤ 60`; out-of-range → 400. Still only display fields; expressions untouched (D5 of v2 holds).

## 4. Layout engine (`ClientApp/src/layout.ts`)

Pure functions over `Item = { id, x, y, w, h }`:

- `autoPlace(tiles) → Item[]`: as above.
- `moveItem(items, id, x, y) → Item[]`: clamp to grid, place the moved item, push colliding items down (recursively), then `compact`.
- `resizeItem(items, id, w, h)`: clamp (min w 4 / h 3; KPI min h 4), push, compact.
- `compact(items)`: sort by (y, x); move each item up while it doesn't collide.
- `nudge(items, id, dir)`: for the Arrange menu and keyboard.

Drag flow: on drag start, snapshot; on drag move, convert the pointer delta to grid cells (`colWidth = (width − 23·gap) / 24`), compute a **preview layout** and render tiles at preview positions with a 150 ms transform transition (the dragged tile follows the pointer, a dashed placeholder shows where it will land); on drop, commit preview → store → debounced save (800 ms) → toast "Layout saved · Undo". Escape cancels the drag.

Rendering: tiles are absolutely positioned inside a container whose height = max(y + h) rows; `left/top/width/height` from the grid maths; charts resize via ResizeObserver (already in `EChart`).

## 5. Visual polish

| # | Change |
|---|---|
| P1 | KPI cards: value + delta chip + "vs prior" on fixed rows so values align (R4); currency symbol (R3); value font 30 px. |
| P2 | Tile header: title and description left, actions right; the header is the drag handle (grab cursor); menu, grip and resize handle fade in on hover/focus. |
| P3 | Surfaces: canvas `--bg` a step darker than cards in dark mode, a step greyer in light mode; card shadow `0 1px 2px` + 1 px border (R6). |
| P4 | Page header: top bar shows breadcrumb "Hub / Demo Retail"; the dashboard title is renamed inline by clicking it (R5). Header actions: Refresh · Add tile · Lock layout · ⋯ (Redesign, Reset layout). |
| P5 | Charts: bar/column with rounded ends, value labels when ≤ 8 bars, legend top-left, gridlines dashed and faint, axis labels use the currency symbol. |
| P6 | Chat empty state: model card (name, tables/measures, "runs on this PC") + suggestion groups ("Explore", "Compare", "Explain") with icons (R7). |
| P7 | Arrange affordances: placeholder outline in accent colour while dragging; tiles show a subtle lift shadow while dragged; a one-time hint "Drag tiles by their title to rearrange" (dismissable, remembered locally). |

## 6. API changes

| Method & path | Change |
|---|---|
| `GET /models/{id}/dashboard` | tiles gain `layout?: {x, y, w, h}`; spec gains `currency?: string` |
| `PUT /models/{id}/dashboard/layout` | tile entries accept `layout` |

## 7. Plan

1. Backend: `TileLayout`, bounds validation, size-from-width, `spec.currency`; tests.
2. `layout.ts` engine + `DashboardCanvas` (drag, resize, placeholder, autosave, undo, lock, narrow fallback); remove Edit mode; Edit-tile popover; Arrange menu.
3. Polish P1–P7; mock updated (layout + currency).
4. Verify on the mock in both themes and at 1366 / 1920 / 1024 px; then `npm run build`.
