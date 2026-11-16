# Semantic Hub

Semantic Hub turns the Power BI models open on your PC into live dashboards you can question in plain language. An AI designs a dashboard for each model and answers questions by writing **read-only DAX** queries. Every number on screen comes from a live query against the model. With the default local AI, nothing leaves your machine.

| | |
|---|---|
| **Hub** | Finds the `.pbix` files open in Power BI Desktop. You add them to a registry, and it caches each model's schema (tables, columns, measures, descriptions, relationships). |
| **Dashboards** | The AI designs a dashboard per model: KPIs, trends, breakdowns and tables. You can filter it, rearrange tiles freely on a grid, add tiles by describing them, and click any number to see how it was calculated. |
| **Ask AI** | A chat beside the dashboard. It answers with numbers from DAX queries it runs, shows its steps live, draws the result as a chart, and lets you pin an answer to the dashboard. |
| **Lock-down** | Read-only queries only, registered models only, row/time/tool-call limits, and an audit log of every query. The browser never sends DAX. |

## Quick start

You need Windows, the .NET 10 SDK, Power BI Desktop and LM Studio with Qwen3 14B. The full list is in [docs/requirements.md](docs/requirements.md).

1. Open your `.pbix` in **Power BI Desktop**.
2. Start **LM Studio**. Load `qwen/qwen3-14b` with a **context length of 16384**, then start the server from the Developer tab (`http://localhost:1234`).
3. Run the app:
   ```
   dotnet run --project src/SemanticHub.Web
   ```
4. Open **http://localhost:5080**. Add the model from "Open in Power BI Desktop", then open its dashboard.

To try the UI with made-up data, without Desktop or LM Studio:
```
cd src/SemanticHub.Web/ClientApp
npm install
npm run dev:mock      # then open http://localhost:5173/models/demo-retail
```

## Documentation

| Read this | For |
|---|---|
| [docs/requirements.md](docs/requirements.md) | What the app needs: hardware, software, AI model, Power BI, network |
| [docs/architecture.md](docs/architecture.md) | The approach and how it works: components, data flow, design decisions |
| [docs/user-guide.md](docs/user-guide.md) | Using the app: hub, dashboards, filters, arranging, chat, pin, audit |
| [docs/security.md](docs/security.md) | Lock-down rules, what stays local, threat model |
| [docs/development.md](docs/development.md) | Code layout, build, tests, mock API, conventions, known gotchas |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems and fixes |
| [docs/v2-api.md](docs/v2-api.md) | HTTP API reference (current) |
| [BRIEF.md](BRIEF.md) | The original project brief and phases |

Design history: [v1 spec](docs/v1-local-spec.md) → [v2 requirements](docs/v2-ui-requirements.md) and [v2 design](docs/v2-ui-design.md) → [v3 design](docs/v3-ui-design.md).

## License

[MIT](LICENSE): free to use, change and share, including commercially, as long as the copyright notice and licence text stay with the code. If Semantic Hub helps you, a link back to [goldlayerdata](https://github.com/goldlayerdata) is appreciated. Third-party components and their licences are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

**Use it locally.** The app has no login and listens on `localhost` only. Don't expose it on a network as-is ([security.md](docs/security.md)).

## Status (2026-11-16)

- **Working:** Desktop discovery and registry; schema harvest with a data profile; AI-designed and built-in dashboards; filters; explain; CSV export; grid layout with drag and resize; chat with live progress, chart answers and pin; add tile by request; audit log; local LLM (LM Studio + Qwen3 14B).
- **Untested:** the Claude (Anthropic API) provider path.
- **Not started:** the Power BI service connector (REST `executeQueries` + MSAL sign-in) and the evaluation set (brief phases 5 and 6).
