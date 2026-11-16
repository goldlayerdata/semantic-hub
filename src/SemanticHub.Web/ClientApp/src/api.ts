// Typed fetch helpers for the /api contract (docs/v2-api.md).
import type {
  AuditEntry,
  DashboardSpec,
  Discovered,
  Explain,
  FilterColumn,
  FilterValue,
  FilterValues,
  HubModel,
  LayoutRequest,
  Status,
  TileResult,
} from "./types";

/** An error whose message is already readable by a person (never raw JSON). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const UNREACHABLE = "Can't reach the Semantic Hub server.";
const UNREACHABLE_HINT = "Check that the app is still running on this PC, then try again.";

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** Turns any thrown value into a readable message plus a suggested next step. */
export function describeError(e: unknown): { message: string; hint?: string } {
  if (e instanceof ApiError) return { message: e.message, hint: e.hint };
  if (e instanceof TypeError) return { message: UNREACHABLE, hint: UNREACHABLE_HINT };
  if (e instanceof Error && e.message) return { message: e.message };
  return { message: "Something went wrong.", hint: "Try again." };
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message: string | undefined;
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      message = typeof data?.error === "string" ? data.error : typeof data?.title === "string" ? data.title : undefined;
    } catch {
      // Short plain-text bodies are fine to show; HTML error pages are not.
      if (text && text.length < 300 && !/<[a-z!]/i.test(text)) message = text.trim();
    }
  } catch {
    /* body unreadable */
  }
  if (res.status === 404) return new ApiError(message ?? "Not found. It may have been removed.", 404, "Go back to the Hub and refresh.");
  if (res.status >= 500)
    return new ApiError(message ?? `The server hit a problem (${res.status}).`, res.status, "Try again. If it keeps happening, check the server log.");
  return new ApiError(message ?? `The request was refused (${res.status}).`, res.status);
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

async function request(path: string, opts: Options = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError(UNREACHABLE, 0, UNREACHABLE_HINT);
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("The server sent a response the app couldn't read.", res.status, "Try again.");
  }
}

/** POST that streams server-sent events (`data: {json}\n\n`), read with fetch so it can carry a body and be aborted. */
export async function sse<E>(path: string, body: unknown, onEvent: (ev: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await request(path, { method: "POST", body: body ?? {}, signal });
  if (!res.body) throw new ApiError("The server closed the stream before sending anything.", res.status, "Try again.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (chunk: string) => {
    const data = chunk
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let parsed: E;
    try {
      parsed = JSON.parse(data) as E;
    } catch {
      return; // ignore keep-alives or malformed lines rather than surfacing JSON errors
    }
    onEvent(parsed);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      flush(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
  }
  if (buffer.trim()) flush(buffer);
}

const enc = encodeURIComponent;

// ---- endpoints ----

export const Api = {
  status: () => api<Status>("/status"),
  discovered: () => api<Discovered[]>("/discovered"),
  models: () => api<HubModel[]>("/models"),
  removeModel: (id: string) => api<void>(`/models/${enc(id)}`, { method: "DELETE" }),
  refreshSchema: (id: string) => api<unknown>(`/models/${enc(id)}/schema/refresh`, { method: "POST", body: {} }),

  dashboard: (id: string) => api<DashboardSpec | null>(`/models/${enc(id)}/dashboard`),
  runTile: (id: string, tileId: string, filters: FilterValue[], signal?: AbortSignal) =>
    api<TileResult>(`/models/${enc(id)}/dashboard/tiles/${enc(tileId)}/run`, { body: { filters }, signal }),
  filterColumns: (id: string) => api<FilterColumn[]>(`/models/${enc(id)}/filters/columns`),
  filterValues: (id: string, table: string, column: string) =>
    api<FilterValues>(`/models/${enc(id)}/filters/values?table=${enc(table)}&column=${enc(column)}`),
  explain: (id: string, tileId: string, filters: FilterValue[]) =>
    api<Explain>(`/models/${enc(id)}/dashboard/tiles/${enc(tileId)}/explain`, { body: { filters } }),
  exportCsv: async (id: string, tileId: string, filters: FilterValue[]): Promise<Blob> => {
    const res = await request(`/models/${enc(id)}/dashboard/tiles/${enc(tileId)}/export`, { method: "POST", body: { filters } });
    return res.blob();
  },
  addTile: (id: string, suggestionId: string) => api<DashboardSpec>(`/models/${enc(id)}/dashboard/tiles`, { body: { suggestionId } }),
  pin: (id: string, body: { conversationId: string; toolId: string; title: string; kind: string; format: string }) =>
    api<DashboardSpec>(`/models/${enc(id)}/dashboard/pin`, { body }),
  saveLayout: (id: string, body: LayoutRequest) => api<DashboardSpec>(`/models/${enc(id)}/dashboard/layout`, { method: "PUT", body }),
  forgetChat: (conversationId: string) => api<void>(`/chat/${enc(conversationId)}`, { method: "DELETE" }),
  audit: (take = 1000) => api<AuditEntry[]>(`/audit?take=${take}`),
};

export const SsePaths = {
  approve: "/models/approve",
  design: (id: string) => `/models/${enc(id)}/dashboard/design`,
  suggest: (id: string) => `/models/${enc(id)}/dashboard/tiles/suggest`,
  chat: "/chat",
};
