# Third-party notices

Semantic Hub is MIT licensed (see [LICENSE](LICENSE)). It uses the open-source components below. The frontend libraries are **bundled** into `src/SemanticHub.Web/wwwroot`; the .NET packages are restored from NuGet at build time and are not stored in this repository.

## Bundled in the web frontend (`wwwroot`)

| Component | Licence |
|---|---|
| [Apache ECharts](https://echarts.apache.org/) 5.5 | Apache-2.0 |
| [ZRender](https://github.com/ecomfe/zrender) (used by ECharts) | BSD-3-Clause |
| [React, React DOM](https://react.dev/) 18.3 | MIT |
| [React Router](https://reactrouter.com/) 6.30 | MIT |
| [Zustand](https://github.com/pmndrs/zustand) 4.5 | MIT |
| [dnd kit](https://dndkit.com/) 6.1 | MIT |
| [marked](https://marked.js.org/) 12.0 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) 3.4 | MPL-2.0 or Apache-2.0 (used under Apache-2.0) |
| [Lucide icons](https://lucide.dev/) 0.453 | ISC |
| [tslib](https://github.com/microsoft/tslib) | 0BSD |

### Apache ECharts NOTICE

```
Apache ECharts
Copyright 2017-2024 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

## .NET packages (restored from NuGet, not redistributed here)

| Package | Licence |
|---|---|
| Microsoft.AnalysisServices.AdomdClient | Microsoft software licence terms (shown on nuget.org; accepted when the package is restored) |
| Microsoft.Extensions.AI, Microsoft.Extensions.AI.OpenAI, System.Management, Microsoft.Extensions.Logging.Abstractions | MIT |
| OpenAI (.NET) | MIT |
| Anthropic (C# SDK) | Apache-2.0 |
| xUnit, coverlet (tests only) | Apache-2.0 / MIT |

## Build tools (not shipped)

Vite, TypeScript and @vitejs/plugin-react (MIT), used only to build the frontend.

## Not included

Power BI Desktop, LM Studio and the AI model weights (e.g. Qwen3) are separate products with their own licences. Users install them separately; they are not part of this repository.
