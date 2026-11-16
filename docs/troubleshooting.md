# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Model shows **offline**; tiles say "Waiting for the model to come online" | The `.pbix` isn't open in Power BI Desktop | Open it; tiles load within a few seconds |
| "Open in Power BI Desktop" list is empty | Desktop is still loading, or no file is open | Wait until the report is visible in Desktop, then **Refresh** on the Hub page |
| Adding a model fails with "at least one table" | Desktop was still loading the file | Wait and add it again; the half-added model is rolled back automatically |
| Status chip red: "Can't reach http://localhost:1234/v1" | LM Studio's server isn't running | LM Studio → Developer → **Start Server** (the app must be open for the `lms` CLI too) |
| Status chip amber: "loaded with a 8,192-token context" | Model loaded with LM Studio's default context | Reload the model with context length **16384** (or set LM Studio's default context to 16384) |
| Chat answers come back empty or cut off | Context too small, or output limit reached | As above; or ask a narrower question |
| "Service request failed" / "graphics driver crashed (GPU device lost)"; LM Studio log shows `vk::Queue::submit: ErrorDeviceLost` | GPU ran out of memory or hit a driver timeout (model + Power BI Desktop + browser + screen recorder all use VRAM). The model stays broken until reloaded | In LM Studio unload and reload the model, e.g. `lms unload --all` then `lms load qwen/qwen3-14b --context-length 16384 --gpu 0.9 --yes` (90% offload leaves headroom); close GPU-heavy apps |
| Each answer takes about a minute | Qwen3 "thinking" is on | Keep `Llm:LocalDisableThinking` = true (default) |
| Dashboard uses the **built-in layout** | The AI wasn't reachable when the dashboard was designed | Fix the AI, then **⋯ → Redesign** |
| Some designed tiles are missing ("dropped" list) | The AI's DAX failed validation twice | Redesign, or add the tile with **Add tile** and a clearer description |
| A tile shows a DAX error | Model changed since the dashboard was designed | **Refresh schema** on the hub card, then Redesign or remove the tile |
| A tile says **not filtered** | Its query can't be wrapped with filters (e.g. uses `DEFINE`) | Expected; re-add it with Add tile to get a filterable version |
| Can't drag tiles | Layout is locked, or the window is too narrow | Click **Locked** to unlock; widen the window (arranging needs about 900 px of dashboard width) |
| Chat panel isn't beside the dashboard | Window narrower than 1600 px | Use the **Ask AI** button (drawer), or widen the window |
| A dashboard lost tiles or got messed up | Unexpected edit | Restore a previous version: copy a file from `%LOCALAPPDATA%\SemanticHub\dashboards\history\{id}\` over `dashboards\{id}.json` |
| `dotnet build` fails: file locked by SemanticHub.Web | The app is running | Stop it first |
| Backend change has no effect | Web project not rebuilt (`dotnet test` doesn't rebuild it) | `dotnet build src/SemanticHub.Web`, restart |
| `npm run dev:mock`: port 5173 or 5090 already in use | An earlier dev server is still running | Stop the old node process (Task Manager, or `Get-NetTCPConnection -LocalPort 5173`) |
| Claude provider: "invalid x-api-key" | `ANTHROPIC_API_KEY` missing or wrong | Set a valid key and restart, or switch `Llm:Provider` back to `local` |

## Where to look

- **Audit page** (`/audit`) or `%LOCALAPPDATA%\SemanticHub\audit\audit-YYYY-MM-DD.jsonl`: every query with its DAX, error and duration.
- **Server console:** startup errors, AI provider errors.
- **Browser dev tools → Network:** API responses; errors come back as `{ "error": "..." }`.
