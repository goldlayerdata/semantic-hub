import { create } from "zustand";
import { Api, describeError, isAbort } from "../api";
import { setCurrency } from "../format";
import { autoPlace, byPosition, compact, mergeLayout, sameLayout, sizeFromWidth, toLayout, type Item } from "../layout";
import type { DashboardSpec, FilterDef, FilterValue, FilterValues, LayoutRequest, Tile, TileResult } from "../types";
import { toast } from "./ui";

export type TileState =
  | { status: "idle" }
  | { status: "loading"; previous?: TileResult }
  | { status: "ok"; result: TileResult }
  | { status: "error"; error: string; hint?: string; result?: TileResult };

export type ValuesState = { status: "loading" } | { status: "ok"; data: FilterValues } | { status: "error"; error: string };
export type SaveState = "idle" | "pending" | "saving" | "error";
export type TileSettings = Partial<Pick<Tile, "title" | "kind" | "format">>;

type DashState = {
  modelId: string | null;
  spec: DashboardSpec | null;
  specState: "idle" | "loading" | "ready" | "empty" | "error";
  specError: string | null;
  results: Record<string, TileState>;
  filtersByModel: Record<string, FilterValue[]>;
  values: Record<string, ValuesState>;
  lastRefreshed: number | null;
  paused: boolean;

  /** v3: live grid layout (source of truth on screen); saved to the spec with a debounce. */
  layout: Item[];
  undoStack: Item[][];
  saveState: SaveState;
  locked: boolean;

  open: (modelId: string) => Promise<void>;
  loadSpec: () => Promise<void>;
  setSpec: (spec: DashboardSpec | null) => void;
  applyNewSpec: (spec: DashboardSpec) => string[];
  setPaused: (paused: boolean) => void;
  runAll: () => void;
  runTiles: (ids: string[]) => void;
  setFilters: (filters: FilterValue[]) => void;
  loadValues: (table: string, column: string) => Promise<void>;
  saveFilterDefs: (defs: FilterDef[]) => Promise<void>;

  commitLayout: (next: Item[]) => void;
  undoLayout: () => void;
  resetLayout: () => void;
  flushSave: () => Promise<void>;
  updateTile: (id: string, patch: TileSettings) => Promise<void>;
  removeTiles: (ids: string[]) => Promise<void>;
  renameDashboard: (title: string) => Promise<void>;
  setLocked: (locked: boolean) => void;
};

export const filterKey = (f: { table: string; column: string }) => `${f.table}\u0000${f.column}`;
const EMPTY: FilterValue[] = [];
export const useActiveFilters = () => useDashboard((s) => (s.modelId ? s.filtersByModel[s.modelId] ?? EMPTY : EMPTY));
export const getActiveFilters = () => {
  const s = useDashboard.getState();
  return s.modelId ? s.filtersByModel[s.modelId] ?? EMPTY : EMPTY;
};

const lockKey = (id: string) => `sh-lock-${id}`;
function readLock(id: string): boolean {
  try {
    return localStorage.getItem(lockKey(id)) === "1";
  } catch {
    return false;
  }
}

// ---- tile runner: at most 3 queries in flight; a new full run cancels the old one ----
const CONCURRENCY = 3;
let generation = 0;
let queue: string[] = [];
let active = 0;
const controllers = new Map<string, AbortController>();
let pendingInRun = 0;

function cancelRuns() {
  generation++;
  queue = [];
  controllers.forEach((c) => c.abort());
  controllers.clear();
  pendingInRun = 0;
}

// ---- layout autosave ----
const SAVE_DELAY = 800;
let saveTimer: number | undefined;
let saveMessage: string | null = null;

export const useDashboard = create<DashState>((set, get) => {
  const pump = () => {
    while (active < CONCURRENCY && queue.length) {
      const id = queue.shift()!;
      active++;
      runOne(id).finally(() => {
        active--;
        pump();
      });
    }
  };

  const runOne = async (tileId: string) => {
    const gen = generation;
    const { modelId } = get();
    if (!modelId) return;
    controllers.get(tileId)?.abort();
    const ctl = new AbortController();
    controllers.set(tileId, ctl);
    const filters = getActiveFilters();
    let next: TileState;
    try {
      const result = await Api.runTile(modelId, tileId, filters, ctl.signal);
      next = result.ok ? { status: "ok", result } : { status: "error", error: result.error || "The query failed.", hint: "Retry, or open View query to check it.", result };
    } catch (e) {
      if (isAbort(e)) return;
      const d = describeError(e);
      next = { status: "error", error: d.message, hint: d.hint };
    } finally {
      if (controllers.get(tileId) === ctl) controllers.delete(tileId);
    }
    if (gen !== generation || get().modelId !== modelId) return;
    set((s) => ({ results: { ...s.results, [tileId]: next } }));
    pendingInRun--;
    if (pendingInRun <= 0) set({ lastRefreshed: Date.now() });
  };

  const markLoading = (ids: string[]) =>
    set((s) => {
      const results = { ...s.results };
      for (const id of ids) {
        const prev = results[id];
        results[id] = { status: "loading", previous: prev?.status === "ok" ? prev.result : prev?.status === "loading" ? prev.previous : undefined };
      }
      return { results };
    });

  /** PUT body from the given tiles + the live layout (tiles in on-screen order, size derived from width). */
  const body = (tiles: Tile[], extra: Partial<LayoutRequest> = {}): LayoutRequest => {
    const pos = new Map(get().layout.map((i) => [i.id, i]));
    const ordered = [...tiles].sort((a, b) => {
      const pa = pos.get(a.id);
      const pb = pos.get(b.id);
      return pa && pb ? byPosition(pa, pb) : 0;
    });
    return {
      tiles: ordered.map((t) => {
        const it = pos.get(t.id);
        return { id: t.id, title: t.title, kind: t.kind, format: t.format, size: it ? sizeFromWidth(it.w) : t.size, ...(it ? { layout: toLayout(it) } : {}) };
      }),
      filters: get().spec?.filters ?? [],
      ...extra,
    };
  };

  const put = async (req: LayoutRequest) => {
    const { modelId } = get();
    if (!modelId) return;
    const updated = await Api.saveLayout(modelId, req);
    if (get().modelId === modelId) get().setSpec(updated);
  };

  const scheduleSave = (message: string) => {
    saveMessage = message;
    set({ saveState: "pending" });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().flushSave(), SAVE_DELAY);
  };

  return {
    modelId: null,
    spec: null,
    specState: "idle",
    specError: null,
    results: {},
    filtersByModel: {},
    values: {},
    lastRefreshed: null,
    paused: false,
    layout: [],
    undoStack: [],
    saveState: "idle",
    locked: false,

    open: async (modelId) => {
      if (get().modelId !== modelId) {
        await get().flushSave(); // never lose a pending layout change when switching models
        cancelRuns();
        set({ modelId, spec: null, specState: "idle", specError: null, results: {}, values: {}, lastRefreshed: null, layout: [], undoStack: [], saveState: "idle", locked: readLock(modelId) });
      }
      await get().loadSpec();
    },

    loadSpec: async () => {
      const { modelId } = get();
      if (!modelId) return;
      set({ specState: get().spec ? "ready" : "loading", specError: null });
      try {
        const spec = await Api.dashboard(modelId);
        if (get().modelId !== modelId) return;
        get().setSpec(spec);
        if (spec) get().runAll();
      } catch (e) {
        if (get().modelId !== modelId) return;
        set({ specState: "error", specError: describeError(e).message });
      }
    },

    setSpec: (spec) => {
      if (!spec) {
        set({ spec: null, specState: "empty", layout: [] });
        return;
      }
      const tiles = spec.tiles ?? [];
      setCurrency(spec.currency);
      const cur = get().layout;
      // The on-screen layout stays authoritative (a newer drag may be waiting to save); new tiles land at the bottom.
      const layout = cur.length ? mergeLayout(cur, tiles) : autoPlace(tiles);
      set({ spec: { ...spec, tiles, filters: spec.filters ?? [] }, specState: "ready", layout });
    },

    applyNewSpec: (spec) => {
      const before = new Set((get().spec?.tiles ?? []).map((t) => t.id));
      const added = (spec.tiles ?? []).filter((t) => !before.has(t.id));
      get().setSpec(spec);
      if (added.length) get().runTiles(added.map((t) => t.id));
      return added.map((t) => t.id);
    },

    setPaused: (paused) => set({ paused }),

    runAll: () => {
      const { spec, paused } = get();
      if (!spec) return;
      cancelRuns();
      if (paused) return;
      const ids = spec.tiles.map((t) => t.id);
      pendingInRun = ids.length;
      markLoading(ids);
      queue = [...ids];
      pump();
    },

    runTiles: (ids) => {
      if (get().paused || !ids.length) return;
      markLoading(ids);
      queue = [...queue.filter((q) => !ids.includes(q)), ...ids];
      pendingInRun += ids.length;
      pump();
    },

    setFilters: (filters) => {
      const { modelId } = get();
      if (!modelId) return;
      const clean = filters.filter((f) => f.values.length);
      set((s) => ({ filtersByModel: { ...s.filtersByModel, [modelId]: clean } }));
      get().runAll();
    },

    loadValues: async (table, column) => {
      const { modelId } = get();
      if (!modelId) return;
      const key = filterKey({ table, column });
      const cur = get().values[key];
      if (cur && cur.status !== "error") return;
      set((s) => ({ values: { ...s.values, [key]: { status: "loading" } } }));
      try {
        const data = await Api.filterValues(modelId, table, column);
        if (get().modelId !== modelId) return;
        set((s) => ({ values: { ...s.values, [key]: { status: "ok", data: { values: data?.values ?? [], truncated: !!data?.truncated } } } }));
      } catch (e) {
        set((s) => ({ values: { ...s.values, [key]: { status: "error", error: describeError(e).message } } }));
      }
    },

    saveFilterDefs: async (defs) => {
      const { spec } = get();
      if (!spec) return;
      await put(body(spec.tiles, { filters: defs }));
      const keep = new Set(defs.map(filterKey));
      const active = getActiveFilters();
      if (active.some((f) => !keep.has(filterKey(f)))) get().setFilters(active.filter((f) => keep.has(filterKey(f))));
    },

    // ---- layout (v3) ----
    commitLayout: (next) => {
      const { layout, undoStack } = get();
      if (sameLayout(next, layout)) return;
      set({ layout: next, undoStack: [...undoStack, layout].slice(-50) });
      scheduleSave("Layout saved");
    },

    undoLayout: () => {
      const { undoStack } = get();
      const prev = undoStack[undoStack.length - 1];
      if (!prev) return;
      set({ layout: prev, undoStack: undoStack.slice(0, -1) });
      scheduleSave("Layout restored");
    },

    resetLayout: () => {
      const spec = get().spec;
      if (spec) get().commitLayout(autoPlace(spec.tiles, true));
    },

    flushSave: async () => {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
      const { spec, saveState } = get();
      if (!spec || (saveState !== "pending" && saveState !== "error")) return;
      const message = saveMessage;
      saveMessage = null;
      set({ saveState: "saving" });
      try {
        await put(body(spec.tiles));
        if (get().saveState === "saving") set({ saveState: "idle" });
        if (message)
          toast(message, "good", get().undoStack.length ? { label: "Undo", run: () => get().undoLayout() } : undefined, "layout");
      } catch (e) {
        set({ saveState: "error" });
        toast(`Couldn't save the layout: ${describeError(e).message}`, "error", { label: "Retry", run: () => void get().flushSave() }, "layout");
      }
    },

    updateTile: async (id, patch) => {
      const spec = get().spec;
      if (!spec) return;
      await get().flushSave();
      await put(body(spec.tiles.map((t) => (t.id === id ? { ...t, ...patch } : t))));
    },

    removeTiles: async (ids) => {
      const spec = get().spec;
      if (!spec) return;
      await get().flushSave();
      const keep = spec.tiles.filter((t) => !ids.includes(t.id));
      set({ layout: compact(get().layout.filter((i) => !ids.includes(i.id))), undoStack: [] });
      await put(body(keep, { removed: ids }));   // deletes are explicit; the server keeps anything not listed
    },

    renameDashboard: async (title) => {
      const spec = get().spec;
      const t = title.trim();
      if (!spec || !t || t === spec.title) return;
      await get().flushSave();
      await put(body(spec.tiles, { title: t }));
    },

    setLocked: (locked) => {
      const { modelId } = get();
      try {
        if (modelId) localStorage.setItem(lockKey(modelId), locked ? "1" : "0");
      } catch {
        /* storage blocked: the lock still applies for this session */
      }
      set({ locked });
    },
  };
});

// Save a pending layout change before the tab closes (best effort).
if (typeof window !== "undefined") window.addEventListener("beforeunload", () => void useDashboard.getState().flushSave());
