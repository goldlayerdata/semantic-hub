import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  Code2,
  Download,
  FilterX,
  GripVertical,
  HelpCircle,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  MoveHorizontal,
  MoveVertical,
  Pencil,
  Trash2,
  BarChart3,
  Table2,
} from "lucide-react";
import { Api, describeError } from "../api";
import { KIND_LABEL } from "../heuristics";
import type { Dir } from "../layout";
import { getActiveFilters, type TileSettings, type TileState } from "../stores/dashboard";
import { toast } from "../stores/ui";
import type { Tile, TileFormat, TileKind, TileResult } from "../types";
import { cx, downloadBlob, safeFileName } from "../util";
import { DaxCode } from "./DaxCode";
import { ErrorBox, Segmented } from "./Feedback";
import { ConfirmDialog, Modal } from "./Modal";
import { MenuList, Popover, type MenuItem } from "./Popover";
import { ResultView, type ExplainPoint } from "./ResultView";

export type TileActions = {
  onExplain: (tile: Tile, point?: ExplainPoint) => void;
  onAsk: (tile: Tile) => void;
  onRetry: (tile: Tile) => void;
  onRemove: (tile: Tile) => Promise<void>;
  onSettings: (tile: Tile, patch: TileSettings) => Promise<void>;
  onArrange: (tile: Tile, dir: Dir) => void;
};

/** Props the canvas hands to a tile so its header works as the drag handle. */
export type DragBinding = {
  /** The grip is dnd-kit's activator node (keyboard drag starts there and focus returns there). */
  gripRef: (el: HTMLElement | null) => void;
  headerProps: HTMLAttributes<HTMLElement>;
  gripProps: HTMLAttributes<HTMLElement>;
  onResizeStart?: (e: React.PointerEvent) => void;
};

type Props = TileActions & {
  modelId: string;
  tile: Tile;
  state: TileState | undefined;
  filtersActive: boolean;
  offline: boolean;
  /** Arranging allowed (not locked, wide screen). */
  arrangeable: boolean;
  drag?: DragBinding;
  dragging?: boolean;
};

const KINDS: TileKind[] = ["kpi", "bar", "column", "line", "area", "donut", "table"];
const FORMATS: { value: TileFormat; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "integer", label: "Integer" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
];

function resultOf(state: TileState | undefined): TileResult | undefined {
  if (!state) return undefined;
  if (state.status === "ok") return state.result;
  if (state.status === "loading") return state.previous;
  if (state.status === "error") return state.result;
  return undefined;
}

export function TileCard({ modelId, tile, state, filtersActive, offline, arrangeable, drag, dragging, onExplain, onAsk, onRetry, onRemove, onSettings, onArrange }: Props) {
  const [menu, setMenu] = useState<null | "main" | "arrange">(null);
  const [editOpen, setEditOpen] = useState(false);
  const [queryOpen, setQueryOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const result = resultOf(state);
  const loading = state?.status === "loading";
  const notFiltered = filtersActive && (!tile.filterable || (result && state?.status === "ok" && !result.filtered));

  const exportCsv = async () => {
    try {
      toast(`Exporting "${tile.title}"…`);
      const blob = await Api.exportCsv(modelId, tile.id, tile.filterable ? getActiveFilters() : []);
      downloadBlob(blob, `${safeFileName(tile.title)}.csv`);
    } catch (e) {
      toast(`Export failed: ${describeError(e).message}`, "error");
    }
  };

  const mainItems: MenuItem[] = [
    { label: "Explain", icon: <HelpCircle size={15} aria-hidden />, onSelect: () => onExplain(tile) },
    { label: "Ask about this", icon: <MessageSquare size={15} aria-hidden />, onSelect: () => onAsk(tile) },
    { label: "View query", icon: <Code2 size={15} aria-hidden />, onSelect: () => setQueryOpen(true) },
    { label: "Export CSV", icon: <Download size={15} aria-hidden />, onSelect: exportCsv, disabled: offline },
    { label: "Fullscreen", icon: <Maximize2 size={15} aria-hidden />, onSelect: () => setFullOpen(true), disabled: !result },
    { label: "Edit tile…", icon: <Pencil size={15} aria-hidden />, onSelect: () => setEditOpen(true), divider: true },
    { label: "Arrange", icon: <LayoutGrid size={15} aria-hidden />, onSelect: () => setMenu("arrange"), keepOpen: true, submenu: true, disabled: !arrangeable },
    { label: "Remove", icon: <Trash2 size={15} aria-hidden />, onSelect: () => setConfirmRemove(true), danger: true, divider: true },
  ];
  const arrange = (dir: Dir): MenuItem["onSelect"] => () => onArrange(tile, dir);
  const arrangeItems: MenuItem[] = [
    { label: "Back", icon: <ChevronLeft size={15} aria-hidden />, onSelect: () => setMenu("main"), keepOpen: true },
    { label: "Move left", icon: <ArrowLeft size={15} aria-hidden />, onSelect: arrange("left"), keepOpen: true, divider: true },
    { label: "Move right", icon: <ArrowRight size={15} aria-hidden />, onSelect: arrange("right"), keepOpen: true },
    { label: "Move up", icon: <ArrowUp size={15} aria-hidden />, onSelect: arrange("up"), keepOpen: true },
    { label: "Move down", icon: <ArrowDown size={15} aria-hidden />, onSelect: arrange("down"), keepOpen: true },
    { label: "Wider", icon: <MoveHorizontal size={15} aria-hidden />, onSelect: arrange("wider"), keepOpen: true, divider: true },
    { label: "Narrower", icon: <MoveHorizontal size={15} aria-hidden />, onSelect: arrange("narrower"), keepOpen: true },
    { label: "Taller", icon: <MoveVertical size={15} aria-hidden />, onSelect: arrange("taller"), keepOpen: true },
    { label: "Shorter", icon: <MoveVertical size={15} aria-hidden />, onSelect: arrange("shorter"), keepOpen: true },
  ];

  const titleId = `tile-title-${tile.id}`;
  const raised = !!menu || editOpen;
  return (
    <section
      className={cx("card tile", `kind-${tile.kind}`, raised && "is-raised", dragging && "is-dragging", arrangeable && "is-arrangeable")}
      aria-labelledby={titleId}
      aria-busy={loading}
      data-tile-id={tile.id}
    >
      <header className={cx("tile-head", arrangeable && "is-handle")} {...(arrangeable ? drag?.headerProps : {})}>
        {arrangeable && drag && (
          <span
            className="tile-grip"
            ref={drag.gripRef}
            {...drag.gripProps}
            role="button"
            tabIndex={0}
            aria-roledescription="draggable tile"
            aria-label={`Move ${tile.title}. Press Space to pick up, arrow keys to move, Space to drop, Escape to cancel.`}
          >
            <GripVertical size={14} aria-hidden />
          </span>
        )}
        <div className="tile-titles">
          <h3 id={titleId} className="tile-title" title={tile.description || tile.title}>
            {tile.title}
          </h3>
          {tile.description && tile.kind !== "kpi" && <div className="tile-desc">{tile.description}</div>}
        </div>
        <div className="tile-tools">
          {notFiltered && (
            <span className="hint-chip" title="This tile has a fixed query and ignores the filter bar.">
              <FilterX size={12} aria-hidden /> Not filtered
            </span>
          )}
          <div className="menu-wrap">
            <button
              ref={menuBtn}
              type="button"
              className="icon-btn tile-kebab"
              aria-label={`Actions for ${tile.title}`}
              aria-haspopup="menu"
              aria-expanded={!!menu}
              onClick={() => setMenu((m) => (m ? null : "main"))}
            >
              <MoreHorizontal size={16} aria-hidden />
            </button>
            <Popover open={!!menu} onClose={() => setMenu(null)} align="end" role="presentation" triggerRef={menuBtn}>
              <MenuList key={menu ?? "x"} onClose={() => setMenu(null)} items={menu === "arrange" ? arrangeItems : mainItems} label={menu === "arrange" ? "Arrange tile" : `Actions for ${tile.title}`} />
            </Popover>
            <Popover open={editOpen} onClose={() => setEditOpen(false)} align="end" className="edit-pop" label={`Edit tile ${tile.title}`} triggerRef={menuBtn}>
              <EditTileForm
                tile={tile}
                onCancel={() => {
                  setEditOpen(false);
                  menuBtn.current?.focus();
                }}
                onSave={async (patch) => {
                  await onSettings(tile, patch);
                  setEditOpen(false);
                  menuBtn.current?.focus();
                }}
              />
            </Popover>
          </div>
        </div>
      </header>

      <div className={cx("tile-body", loading && result && "is-refreshing")}>
        <TileBody tile={tile} state={state} result={result} offline={offline} onRetry={() => onRetry(tile)} onPoint={(p) => onExplain(tile, tile.kind === "kpi" ? { ...p, series: tile.title } : p)} />
      </div>

      {arrangeable && drag?.onResizeStart && (
        <span className="resize-handle" onPointerDown={drag.onResizeStart} aria-hidden title="Drag to resize">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
      )}

      <Modal
        open={queryOpen}
        onClose={() => setQueryOpen(false)}
        title="Query"
        subtitle={
          <>
            {tile.title}
            {result ? ` · ${result.rows.length.toLocaleString()} rows · ${result.durationMs} ms` : ""}
            {result?.filtered ? " · with dashboard filters" : ""}
          </>
        }
        size="lg"
      >
        {result?.query || tile.dax || tile.expression ? (
          <>
            <DaxCode code={result?.query || tile.dax || tile.expression || ""} maxHeight={480} />
            {!result?.query && <p className="muted small">This is the tile's stored expression; the exact query appears after the tile has run.</p>}
          </>
        ) : (
          <p className="muted">The query is shown once the tile has run.</p>
        )}
      </Modal>

      {result && (
        <FullscreenDialog
          open={fullOpen}
          onClose={() => setFullOpen(false)}
          tile={tile}
          result={result}
          onPoint={(p) => {
            setFullOpen(false);
            onExplain(tile, p);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove "${tile.title}"?`}
        body={<p>The tile is removed from this dashboard. You can add it back with Add tile or by pinning an answer.</p>}
        confirmLabel="Remove"
        danger
        busy={removing}
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setRemoving(true);
          try {
            await onRemove(tile);
            setConfirmRemove(false);
          } finally {
            setRemoving(false);
          }
        }}
      />
    </section>
  );
}

function EditTileForm({ tile, onSave, onCancel }: { tile: Tile; onSave: (p: TileSettings) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(tile.title);
  const [kind, setKind] = useState<TileKind>(tile.kind);
  const [format, setFormat] = useState<TileFormat>(tile.format);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.select(), []);
  const changed = title.trim() !== tile.title || kind !== tile.kind || format !== tile.format;

  return (
    <form
      className="edit-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!changed) return onCancel();
        setBusy(true);
        setError(null);
        try {
          await onSave({ title: title.trim() || tile.title, kind, format });
        } catch (err) {
          setError(describeError(err).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="edit-form-title">Edit tile</div>
      <label className="field">
        <span className="field-label">Title</span>
        <input ref={first} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="field">
        <span className="field-label" id={`kind-${tile.id}`}>
          Chart type
        </span>
        <div className="kind-grid" role="radiogroup" aria-labelledby={`kind-${tile.id}`}>
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={cx("kind-opt", kind === k && "is-on")} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="field-label">Number format</span>
        <select className="select" value={format} onChange={(e) => setFormat(e.target.value as TileFormat)}>
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {error && <ErrorBox compact message={error} />}
      <div className="edit-form-foot">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          {busy && <span className="spinner sm" aria-hidden />} Save
        </button>
      </div>
    </form>
  );
}

function TileBody({
  tile,
  state,
  result,
  offline,
  onRetry,
  onPoint,
}: {
  tile: Tile;
  state: TileState | undefined;
  result: TileResult | undefined;
  offline: boolean;
  onRetry: () => void;
  onPoint?: (p: ExplainPoint) => void;
}) {
  if (state?.status === "error")
    return (
      <div className="tile-error">
        <ErrorBox compact message={state.error} hint={state.hint} onRetry={offline ? undefined : onRetry} retryLabel="Retry" />
      </div>
    );
  if (!result) {
    if (offline || !state || state.status === "idle") return <div className="tile-waiting muted small">{offline ? "Waiting for the model to come online." : "Not loaded yet."}</div>;
    return <TileSkeleton kind={tile.kind} />;
  }
  return <ResultView kind={tile.kind} format={tile.format} columns={result.columns} rows={result.rows} truncated={result.truncated} label={tile.title} onPoint={onPoint} />;
}

export function TileSkeleton({ kind }: { kind: TileKind }) {
  if (kind === "kpi")
    return (
      <div className="tile-skeleton" aria-label="Loading" role="status">
        <div className="skeleton sk-kpi" />
        <div className="skeleton sk-line w40" />
      </div>
    );
  if (kind === "table")
    return (
      <div className="tile-skeleton" aria-label="Loading" role="status">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton sk-line" style={{ width: `${90 - i * 6}%` }} />
        ))}
      </div>
    );
  return (
    <div className="tile-skeleton sk-chart" aria-label="Loading" role="status">
      {[62, 88, 45, 74, 56, 80, 38].map((h, i) => (
        <div key={i} className="skeleton sk-bar" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

function FullscreenDialog({ open, onClose, tile, result, onPoint }: { open: boolean; onClose: () => void; tile: Tile; result: TileResult; onPoint: (p: ExplainPoint) => void }) {
  const [view, setView] = useState<"chart" | "table">(tile.kind === "table" ? "table" : "chart");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tile.title}
      subtitle={tile.description}
      size="xl"
      footer={
        <>
          <span className="muted small grow">
            {result.rows.length.toLocaleString()} rows · {result.durationMs} ms{result.truncated ? " · capped" : ""}
          </span>
          <Segmented<"chart" | "table">
            label="View as"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "chart", label: <><BarChart3 size={14} aria-hidden /> Chart</> as ReactNode },
              { value: "table", label: <><Table2 size={14} aria-hidden /> Table</> as ReactNode },
            ]}
          />
        </>
      }
    >
      <div className={cx("fullscreen-body", view === "table" && "is-table")}>
        <ResultView kind={view === "table" ? "table" : tile.kind} format={tile.format} columns={result.columns} rows={result.rows} truncated={result.truncated} label={tile.title} onPoint={onPoint} />
      </div>
    </Modal>
  );
}

