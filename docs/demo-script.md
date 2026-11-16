# Demo recording: shot list

A 60–90 second screen recording of Semantic Hub on the **Contoso sample model**. The goal is to show "ask your Power BI model in plain language, every number comes from a live query, nothing leaves the PC".

## Before you record

1. Open the **Contoso `.pbix`** in Power BI Desktop and wait until the report shows.
2. Start **LM Studio**, load `qwen/qwen3-14b` with **context length 16384**, and start the server (Developer tab).
3. Run `dotnet run --project src/SemanticHub.Web` and open http://localhost:5080. The status chip should be green: "Local · qwen3-14b · runs on this PC".
4. **Do the slow parts before recording:**
   - Add the model in the hub.
   - Create its dashboard (1–2 min).
   - Arrange the tiles the way you want.
   - Ask the demo question once, so the model is warm.
   - Click **New chat** afterwards.
5. Make the browser window **1600 px wide or more**, so the chat sits beside the dashboard. Pick a theme; dark looks best on video. Close other tabs and notifications.
6. Recorder: Windows **Snipping Tool → Record** (Win + Shift + R) or **Xbox Game Bar** (Win + Alt + R).

## Shot list

| # | Time | Do | Say or caption |
|---|---|---|---|
| 1 | 0–8 s | Show the Hub with the Contoso card (online, description coverage) | "Power BI models open on this PC, in one hub." |
| 2 | 8–20 s | Open the dashboard; let the tiles load | "An AI-designed dashboard. Every number is a live, read-only DAX query." |
| 3 | 20–30 s | Pick a **Year** filter, then a **Category**; the tiles update | "Filters work on every tile." |
| 4 | 30–38 s | Click a KPI value; show the Explain panel (measure, DAX) | "Click any number to see exactly how it was calculated." |
| 5 | 38–46 s | Drag a chart to a new place and resize another | "Arrange it like a report." |
| 6 | 46–75 s | In **Ask AI**, type: *"Top 5 product categories by revenue this year"*; let the live steps run | "Ask in plain language. It writes the DAX, runs it, and shows its steps." |
| 7 | 75–85 s | Show the answer chart, open **How I got this**, click **Pin to dashboard** | "Answers come with their query, and you can pin them." |
| 8 | 85–90 s | Point at the status chip | "Runs on a local model, so nothing leaves the PC." |

## Tips

- An answer takes 10–30 s on the local model. Keep the live steps in the take, because they show the app working. Speed the wait up 2× in editing if needed.
- Use only the public Contoso sample, never a client model.
- Keep the URL bar out of frame or as-is; it only shows `localhost`.
- If a step goes wrong, use **Undo** (layout) or **New chat**, then retake that shot.
