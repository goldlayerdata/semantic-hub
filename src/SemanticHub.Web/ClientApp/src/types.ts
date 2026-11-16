// Contract types — mirror docs/v2-api.md. JSON is camelCase.

export type Scalar = string | number | boolean | null;

export type FilterDef = { table: string; column: string; label: string };
export type FilterValue = { table: string; column: string; values: Scalar[] };
export type QueryColumn = { name: string; type: string };

export type TileKind = "kpi" | "bar" | "column" | "line" | "area" | "donut" | "table";
export type TileFormat = "number" | "integer" | "currency" | "percent";
export type TileSize = "small" | "medium" | "large" | "full";
/** v3: position on the 24-column dashboard grid, in grid units. Absent = place automatically. */
export type TileLayout = { x: number; y: number; w: number; h: number };

export type Tile = {
  id: string;
  title: string;
  kind: TileKind;
  format: TileFormat;
  size: TileSize;
  description?: string;
  origin: "designer" | "builtin" | "pinned" | "added";
  filterable: boolean;
  layout?: TileLayout | null;
  expression?: string;
  orderBy?: string;
  dax?: string;
};

export type DashboardSpec = {
  title: string;
  subtitle?: string;
  version: number;
  tiles: Tile[];
  filters: FilterDef[];
  generatedAt: string;
  generatedBy: string;
  droppedTiles: string[];
  /** v3: currency symbol derived from the model's format strings, e.g. "$". */
  currency?: string | null;
};

export type TileResult = {
  tileId: string;
  ok: boolean;
  error?: string;
  columns: QueryColumn[];
  rows: unknown[][];
  truncated: boolean;
  durationMs: number;
  query?: string;
  filtered: boolean;
};

export type LlmStatus = {
  provider: "local" | "claude";
  model: string;
  ready: boolean;
  problem?: string | null;
  warning?: string | null;
  endpoint?: string | null;
};

export type Status = {
  llm: LlmStatus;
  limits: { maxRows: number; queryTimeoutSeconds: number; maxToolCallsPerQuestion: number };
  dataDirectory: string;
};

export type Discovered = { key: string; name: string; route: string; sourcePath: string; hubId: string | null };

export type ModelCounts = { tables: number; columns: number; measures: number };
export type ModelHealth = {
  measures: number;
  measuresWithoutDescription: number;
  visibleColumns: number;
  columnsWithoutDescription: number;
  tablesWithoutDescription: number;
};

export type HubModel = {
  id: string;
  name: string;
  route: string;
  sourcePath: string;
  addedAt: string;
  online: boolean;
  schemaHarvestedAt: string | null;
  counts: ModelCounts | null;
  health: ModelHealth | null;
  hasDashboard: boolean;
};

export type FilterColumn = { table: string; column: string; dataType: string; label: string };
export type FilterValues = { values: Scalar[]; truncated: boolean };

export type Explain = {
  tileId: string;
  title: string;
  description?: string;
  measures: { name: string; table: string; description?: string; expression?: string; formatString?: string }[];
  columns: { table: string; column: string; description?: string }[];
  filters: { label: string; values: Scalar[] }[];
  query: string;
  filterable: boolean;
};

export type LayoutTile = Pick<Tile, "id" | "title" | "kind" | "size" | "format"> & { layout?: TileLayout };
/** Tiles not listed are kept by the server; only ids in `removed` are deleted. */
export type LayoutRequest = { title?: string; tiles: LayoutTile[]; filters: FilterDef[]; removed?: string[] };

// ---- SSE events ----

export type ApproveEvent =
  | { type: "progress"; step: "connect" | "schema" | "profile"; text: string }
  | { type: "done"; model: HubModel }
  | { type: "error"; error: string };

export type DesignEvent =
  | { type: "progress"; text: string }
  | { type: "done"; spec: DashboardSpec }
  | { type: "error"; error: string };

export type SuggestEvent =
  | { type: "progress"; text: string }
  | { type: "done"; suggestionId: string; tile: Tile; result: TileResult }
  | { type: "error"; error: string };

export type ChatStage = "understanding" | "running" | "reading" | "answering";

export type ChatEvent =
  | { type: "session"; conversationId: string }
  | { type: "stage"; stage: ChatStage | string; text?: string; toolId?: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolId: string; tool: string; modelId?: string; dax?: string }
  | {
      type: "tool_result";
      toolId: string;
      ok: boolean;
      rejected?: boolean;
      error?: string;
      rows?: number;
      truncated?: boolean;
      durationMs?: number;
      columns?: QueryColumn[] | string[];
      preview?: unknown[][];
    }
  | { type: "text"; text: string }
  | { type: "notice"; text: string }
  | { type: "answer_data"; toolId: string; dax: string; columns: QueryColumn[] | string[]; rows: unknown[][]; truncated: boolean }
  | {
      type: "done";
      usage?: { provider: string; model: string; inputTokens: number; outputTokens: number; toolCalls: number };
      elapsedMs?: number;
    }
  | { type: "error"; error: string };

export type AuditEntry = {
  at: string;
  source: "agent" | "dashboard" | "designer" | "schema";
  modelId: string | null;
  conversationId: string | null;
  question: string | null;
  dax: string | null;
  rows: number | null;
  truncated: boolean;
  durationMs: number | null;
  rejected: boolean;
  error: string | null;
  note: string | null;
};
