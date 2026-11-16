# User guide

## 1. Start

1. Open your `.pbix` in **Power BI Desktop**. Several files can be open at once.
2. Make sure **LM Studio's server** is running with the model loaded; see [requirements.md](requirements.md).
3. Run `dotnet run --project src/SemanticHub.Web` and open **http://localhost:5080**.

The **status chip** (top right) shows which AI is in use:

| Chip | Meaning |
|---|---|
| Green "Local · qwen3-14b · runs on this PC" | Ready, nothing leaves the PC |
| Amber | Works, but with a warning, e.g. the model is loaded with too small a context |
| Red | The AI is not reachable. Dashboards fall back to the built-in layout and chat is unavailable |

Click the chip for details and the next step. Use the sun, moon and screen icons to switch between light, dark and system themes.

## 2. Hub: add a model

- **Open in Power BI Desktop** lists open files that aren't in the hub yet. Click **Add** and watch the steps: connect → read schema → profile data.
- Each **model card** shows:
  - whether the file is open (online/offline)
  - table, column and measure counts
  - **description coverage** (more descriptions mean better answers)
  - when the schema was read
- **Refresh schema** after changing the model in Desktop.
- **Remove** takes the model out of the hub. It deletes the cached schema and dashboard, but never touches the `.pbix`.

## 3. Dashboard

**Create dashboard** asks the AI to design one; this takes 1–2 minutes on a local model, with live progress. **⋯ → Redesign** does it again from scratch.

### Read it
- **KPI cards** show the value, plus a change against the prior period when the model has a measure for it.
- **Charts:** hover for values; the legend toggles series.
- **Last refreshed** shows when tiles last ran. **Refresh** re-runs them all.
- A tile that fails shows its own error with **Retry**; the rest keep working.

### Filter it
- The filter bar under the title has 2–4 filters chosen by the designer (e.g. Year, Category, Country).
- Open one, tick values, then close it, and every tile re-runs with the filter. Active filters show as chips; **Clear all** resets.
- **+ Filter** adds another column from the model; **Remove filter** inside a dropdown takes it away.
- Tiles marked **not filtered** use a query that can't take filters; they always show totals.

### Explain a number
Click a KPI value or a chart point. The side panel shows:
- the point you clicked
- the **measures** used, with their descriptions and DAX
- the columns and the filters in effect
- the exact query that ran

**Ask why** puts a question about that number into the chat for you to send.

### Arrange it
| Do | How |
|---|---|
| Move a tile | Drag it by its **title**. A dashed outline shows where it lands. Dragging sideways reorders the row; dragging up or down swaps places |
| Resize | Drag the **bottom-right corner** (appears on hover). Tiles snap to the grid and the rest move out of the way |
| Cancel a drag | Press **Escape** |
| Undo | **Undo** on the "Layout saved" message, or **Ctrl+Z** |
| Use the keyboard | Tile menu → **Arrange** (move, wider/narrower, taller/shorter), or focus the grip, press **Space**, use the arrows, then Space again |
| Prevent accidental moves | **Lock layout**; the button then reads **Locked**, click it again to unlock (remembered per model in this browser) |
| Start over | **⋯ → Reset layout** |

Changes save automatically. On narrow windows (under about 900 px of dashboard width) the tiles stack in one column, and arranging is off until the window is wider.

### Change or remove a tile
- **Tile menu (⋯)** has these items:
  - **Edit tile:** title, chart type, number format
  - **Explain**
  - **Ask about this**
  - **View query** (with Copy)
  - **Export CSV**: the tile's data under the current filters
  - **Fullscreen**: has a table view of every chart
  - **Remove**: asks for confirmation; it can't be undone
- **Add tile:** describe what you want, e.g. "margin % by category as a column chart". The AI writes the query, the app checks it against the model, and you see a **preview** before **Add to dashboard**.

## 4. Ask AI

The panel on the right (on smaller screens, the **Ask AI** button opens it as a drawer).
- Type a question, or pick a suggestion. Questions use the **active dashboard filters** unless you say otherwise.
- The **steps** update live with a timer: understanding the question → running query (rows, ms) → reading the results → writing the answer. **Stop** cancels.
- An answer has:
  - **text** that names the measure and period used
  - a **chart or table** of the data, where you can switch the chart type
  - **How I got this**: every query with its DAX, row counts, the filters, the model and the time taken
- **Pin to dashboard** turns the answer's data into a tile; edit the title first if you like.
- **New chat** starts over. The AI remembers earlier questions in the same chat.

Good questions name a measure and a breakdown: "Top 5 categories by revenue in 2025", "How did orders change by month?", "Which country grew fastest vs last year?". If the model can't answer, the AI says so instead of guessing.

## 5. Audit

**Audit** lists every query the app ran: from the dashboard, the designer, the AI agent and schema reads. Each entry has:
- the time and the source
- the model
- the question (or the tile name)
- the DAX
- row count and duration
- the outcome: ok, failed, or blocked by the read-only guard

Search, filter by source, outcome or model, and expand an entry to see its DAX. AI questions are grouped by conversation.

## 6. Try it without Power BI

For demos or UI work without Desktop or an AI server:
```
cd src/SemanticHub.Web/ClientApp
npm install
npm run dev:mock
```
Open http://localhost:5173/models/demo-retail. The data is made up and chat answers are scripted; everything else (filters, arranging, pin, add tile, audit) behaves like the real app.
