import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { LayoutDashboard, LayoutTemplate, Lock, LockOpen, MoreHorizontal, Plus, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { SsePaths, describeError, isAbort, sse } from "../api";
import { AddTileDialog } from "../components/AddTileDialog";
import { PageActions, usePageTitle } from "../components/AppShell";
import { ChatPanel } from "../components/ChatPanel";
import { DashboardCanvas } from "../components/DashboardCanvas";
import { ExplainPanel, type ExplainTarget } from "../components/ExplainPanel";
import { Banner, EmptyState, ErrorBox } from "../components/Feedback";
import { FilterBar } from "../components/FilterBar";
import { ConfirmDialog } from "../components/Modal";
import { MenuList, Popover } from "../components/Popover";
import { ProgressLog } from "../components/ProgressSteps";
import type { TileActions } from "../components/Tile";
import { clockTime, filtersText, plural, timeAgo } from "../format";
import { nudge } from "../layout";
import { useChat } from "../stores/chat";
import { filterKey, useActiveFilters, useDashboard } from "../stores/dashboard";
import { useHub, useModel } from "../stores/hub";
import { CHAT_DOCK_MIN, toast, useMediaQuery, useUi } from "../stores/ui";
import type { DashboardSpec, DesignEvent } from "../types";
import { cx } from "../util";

type DesignRun = { lines: string[]; startedAt: number } | null;

export function DashboardPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const model = useModel(id);
  const modelsLoaded = useHub((s) => s.modelsLoaded);
  const modelsError = useHub((s) => s.modelsError);
  const loadModels = useHub((s) => s.loadModels);
  usePageTitle(model?.name ?? "Dashboard", { label: "Hub", to: "/" });

  const spec = useDashboard((s) => s.spec);
  const specState = useDashboard((s) => s.specState);
  const specError = useDashboard((s) => s.specError);
  const results = useDashboard((s) => s.results);
  const layout = useDashboard((s) => s.layout);
  const lastRefreshed = useDashboard((s) => s.lastRefreshed);
  const saveState = useDashboard((s) => s.saveState);
  const locked = useDashboard((s) => s.locked);
  const active = useActiveFilters();
  const offline = !!model && !model.online;

  const { chatOpen, setChatOpen } = useUi();
  const drawer = useMediaQuery(`(max-width: ${CHAT_DOCK_MIN - 0.02}px)`);

  const [explain, setExplain] = useState<ExplainTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmRedesign, setConfirmRedesign] = useState(false);
  const [design, setDesign] = useState<DesignRun>(null);
  const [designError, setDesignError] = useState<{ message: string; hint?: string } | null>(null);
  const designCtl = useRef<AbortController | null>(null);
  const autoDesigned = useRef(false);
  const moreBtn = useRef<HTMLButtonElement>(null);

  // N6: offline models pause tile runs; resume when it comes back
  const wasOffline = useRef(offline);
  useEffect(() => {
    useDashboard.getState().setPaused(offline);
    if (wasOffline.current && !offline && useDashboard.getState().spec) useDashboard.getState().runAll();
    wasOffline.current = offline;
  }, [offline]);

  // Open the model's dashboard once we know whether it's online (so offline models never fire tile queries).
  useEffect(() => {
    if (!modelsLoaded) return;
    autoDesigned.current = false;
    setDesignError(null);
    setExplain(null);
    useDashboard.getState().open(id);
    return () => designCtl.current?.abort();
  }, [id, modelsLoaded]);

  // Save a pending layout change when leaving the page.
  useEffect(() => () => void useDashboard.getState().flushSave(), []);

  const labelOf = useCallback((table: string, column: string) => spec?.filters.find((f) => filterKey(f) === filterKey({ table, column }))?.label ?? column, [spec]);
  const activeText = useMemo(() => filtersText(active.map((f) => ({ label: labelOf(f.table, f.column), values: f.values }))), [active, labelOf]);

  const runDesign = useCallback(async () => {
    designCtl.current?.abort();
    const ac = new AbortController();
    designCtl.current = ac;
    setDesignError(null);
    setDesign({ lines: ["Reading the model schema"], startedAt: Date.now() });
    const out: { spec?: DashboardSpec; error?: string } = {};
    try {
      await sse<DesignEvent>(
        SsePaths.design(id),
        {},
        (ev) => {
          if (ev.type === "progress") setDesign((r) => (r ? { ...r, lines: [...r.lines, ev.text] } : r));
          else if (ev.type === "done") out.spec = ev.spec;
          else if (ev.type === "error") out.error = ev.error;
        },
        ac.signal,
      );
      if (out.error) throw new Error(out.error);
      if (!out.spec) throw new Error("The designer finished without returning a dashboard.");
      const st = useDashboard.getState();
      if (st.modelId !== id) return;
      // A redesign replaces every tile: start from a fresh layout.
      useDashboard.setState({ layout: [], undoStack: [] });
      st.setSpec(out.spec);
      st.runAll();
      loadModels();
      toast("Dashboard designed", "good");
    } catch (e) {
      if (!isAbort(e)) {
        const m = describeError(e);
        setDesignError({ message: m.message, hint: m.hint ?? "Check the AI status chip in the top bar, then try again." });
      }
    } finally {
      if (designCtl.current === ac) {
        designCtl.current = null;
        setDesign(null);
      }
    }
  }, [id, loadModels]);

  // Arrived from "Create dashboard": start designing straight away.
  useEffect(() => {
    if (specState === "empty" && (location.state as { design?: boolean } | null)?.design && !autoDesigned.current && !offline && model) {
      autoDesigned.current = true;
      navigate(location.pathname, { replace: true, state: null });
      runDesign();
    }
  }, [specState, location, navigate, runDesign, offline, model]);

  // Ctrl+Z undoes the last layout change (text fields keep their own undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
        if (!useDashboard.getState().undoStack.length) return;
        e.preventDefault();
        useDashboard.getState().undoLayout();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tiles = spec?.tiles ?? [];
  const anyLoading = tiles.some((t) => results[t.id]?.status === "loading");
  const openChat = () => setChatOpen(true);

  const actions: TileActions = useMemo(
    () => ({
      onExplain: (tile, point) => setExplain({ tile, point }),
      onAsk: (tile) => {
        setChatOpen(true);
        useChat.getState().setDraft(id, `About the "${tile.title}" tile: `, true);
      },
      onRetry: (tile) => useDashboard.getState().runTiles([tile.id]),
      onRemove: async (tile) => {
        try {
          await useDashboard.getState().removeTiles([tile.id]);
          toast(`Removed "${tile.title}"`);
        } catch (e) {
          toast(`Couldn't remove the tile: ${describeError(e).message}`, "error");
          throw e;
        }
      },
      onSettings: async (tile, patch) => {
        await useDashboard.getState().updateTile(tile.id, patch);
        toast("Tile updated", "good");
      },
      onArrange: (tile, dir) => {
        const st = useDashboard.getState();
        st.commitLayout(nudge(st.layout, tile.id, dir, tile.kind));
      },
    }),
    [id, setChatOpen],
  );

  const afterNewTiles = (newSpec: DashboardSpec, verb: string) => {
    const added = useDashboard.getState().applyNewSpec(newSpec);
    if (!added.length) return;
    toast(verb, "good", {
      label: "Undo",
      run: async () => {
        try {
          await useDashboard.getState().removeTiles(added);
          toast("Tile removed");
        } catch (e) {
          toast(`Couldn't undo: ${describeError(e).message}`, "error");
        }
      },
    });
    window.setTimeout(() => document.querySelector(`[data-tile-id="${CSS.escape(added[0])}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
  };

  // ---------- render ----------

  if (modelsLoaded && !modelsError && !model)
    return (
      <div className="page">
        <EmptyState
          icon={<LayoutDashboard size={28} />}
          title="This model isn't in the hub"
          actions={
            <Link className="btn btn-primary" to="/">
              Go to the Hub
            </Link>
          }
        >
          It may have been removed. Add it again from the Hub.
        </EmptyState>
      </div>
    );

  const showChat = chatOpen && !!model;
  const status = anyLoading
    ? "Refreshing…"
    : saveState === "saving" || saveState === "pending"
      ? "Saving layout…"
      : saveState === "error"
        ? "Layout not saved"
        : lastRefreshed
          ? `Last refreshed ${clockTime(lastRefreshed)}`
          : offline
            ? "Not refreshed — model offline"
            : "";

  return (
    <div className={cx("dash-layout", showChat && !drawer && "with-chat")}>
      <PageActions>
        {!showChat && (
          <button type="button" className="btn" onClick={openChat}>
            <Sparkles size={14} aria-hidden /> Ask AI
          </button>
        )}
      </PageActions>

      <div className="dash-main">
        <div className="page dash-page">
          {offline && (
            <Banner
              tone="warn"
              action={
                <button type="button" className="btn btn-sm" onClick={loadModels}>
                  Check again
                </button>
              }
            >
              <strong>{model?.name} is offline.</strong> Power BI Desktop isn't serving this model right now. Open <span className="mono">{model?.sourcePath}</span> in Power BI Desktop; the
              tiles load as soon as it's back.
            </Banner>
          )}

          {specState === "loading" || specState === "idle" ? (
            <DashSkeleton />
          ) : specState === "error" ? (
            <ErrorBox message={specError ?? "The dashboard couldn't be loaded."} hint="Check that the app is running, then try again." onRetry={() => useDashboard.getState().loadSpec()} />
          ) : specState === "empty" || !spec ? (
            design ? (
              <section className="card design-card">
                <h2 className="design-title">
                  <Wand2 size={18} aria-hidden /> Designing a dashboard for {model?.name}
                </h2>
                <ProgressLog lines={design.lines} running startedAt={design.startedAt} onCancel={() => designCtl.current?.abort()} note="Takes 1–2 minutes on a local model." />
              </section>
            ) : (
              <EmptyState
                icon={<LayoutDashboard size={28} />}
                title="No dashboard yet"
                actions={
                  <button type="button" className="btn btn-primary" onClick={runDesign} disabled={offline}>
                    <Wand2 size={14} aria-hidden /> Design dashboard
                  </button>
                }
              >
                The AI reads the model's tables, measures and descriptions and lays out KPIs and charts for it. This takes 1–2 minutes on a local model.
                {designError && (
                  <div className="mt">
                    <ErrorBox message={designError.message} hint={designError.hint} />
                  </div>
                )}
              </EmptyState>
            )
          ) : (
            <>
              <header className="dash-head">
                <div className="dash-titles">
                  <EditableTitle value={spec.title} />
                  {spec.subtitle && <p className="dash-sub">{spec.subtitle}</p>}
                  <p className={cx("dash-meta small", saveState === "error" ? "bad-text" : "muted")} aria-live="polite">
                    {status}
                  </p>
                </div>
                <div className="dash-actions">
                  <button type="button" className="btn" onClick={() => useDashboard.getState().runAll()} disabled={offline || anyLoading || !!design}>
                    <RefreshCw size={14} aria-hidden className={cx(anyLoading && "spin")} /> Refresh
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)} disabled={offline || !!design}>
                    <Plus size={14} aria-hidden /> Add tile
                  </button>
                  <button
                    type="button"
                    className={cx("btn", locked && "is-pressed")}
                    aria-pressed={locked}
                    onClick={() => {
                      useDashboard.getState().setLocked(!locked);
                      toast(locked ? "Layout unlocked — drag tiles to rearrange" : "Layout locked", "info");
                    }}
                    title={locked ? "Unlock to move and resize tiles" : "Lock to prevent accidental moves (e.g. during a demo)"}
                  >
                    {locked ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />} {locked ? "Locked" : "Lock layout"}
                  </button>
                  <div className="menu-wrap">
                    <button ref={moreBtn} type="button" className="icon-btn btn-like" aria-label="More dashboard actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
                      <MoreHorizontal size={16} aria-hidden />
                    </button>
                    <Popover open={moreOpen} onClose={() => setMoreOpen(false)} align="end" role="presentation" triggerRef={moreBtn}>
                      <MenuList
                        label="More dashboard actions"
                        onClose={() => setMoreOpen(false)}
                        items={[
                          { label: "Redesign with AI…", icon: <Wand2 size={15} aria-hidden />, onSelect: () => setConfirmRedesign(true), disabled: offline || !!design },
                          { label: "Reset layout", icon: <LayoutTemplate size={15} aria-hidden />, onSelect: () => useDashboard.getState().resetLayout(), disabled: locked },
                        ]}
                      />
                    </Popover>
                  </div>
                </div>
              </header>

              {design && (
                <section className="card design-card">
                  <h2 className="design-title">
                    <Wand2 size={18} aria-hidden /> Redesigning the dashboard
                  </h2>
                  <ProgressLog lines={design.lines} running startedAt={design.startedAt} onCancel={() => designCtl.current?.abort()} note="The current dashboard stays until the new one is ready." />
                </section>
              )}
              {designError && <ErrorBox message={designError.message} hint={designError.hint} onRetry={runDesign} />}

              <FilterBar modelId={id} defs={spec.filters} />

              {tiles.length === 0 ? (
                <EmptyState
                  title="This dashboard has no tiles"
                  actions={
                    <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)} disabled={offline}>
                      <Plus size={14} aria-hidden /> Add tile
                    </button>
                  }
                >
                  Add a tile by describing what you want to see, or pin an answer from Ask AI.
                </EmptyState>
              ) : (
                <div className={cx("canvas-host", design && "is-dimmed")}>
                  <DashboardCanvas
                    modelId={id}
                    tiles={tiles}
                    layout={layout}
                    results={results}
                    filtersActive={active.length > 0}
                    offline={offline}
                    locked={locked}
                    actions={actions}
                    onCommit={(next) => useDashboard.getState().commitLayout(next)}
                  />
                </div>
              )}

              <footer className="dash-foot small muted">
                Designed {timeAgo(spec.generatedAt)} by {spec.generatedBy}
                {spec.droppedTiles?.length ? ` · ${plural(spec.droppedTiles.length, "tile")} dropped by the safety gate` : ""} · Every number comes from a live, read-only DAX query.
              </footer>
            </>
          )}
        </div>
      </div>

      {showChat && (
        <ChatPanel
          modelId={id}
          model={model!}
          spec={spec}
          filters={active}
          filtersText={activeText}
          offline={offline}
          drawer={drawer}
          onClose={() => setChatOpen(false)}
          onPinned={(s) => afterNewTiles(s, "Pinned to the dashboard")}
        />
      )}

      <ExplainPanel
        modelId={id}
        target={explain}
        onClose={() => setExplain(null)}
        filterLabels={labelOf}
        onAskWhy={(prompt) => {
          setExplain(null);
          openChat();
          useChat.getState().setDraft(id, prompt, true);
        }}
      />
      <AddTileDialog modelId={id} open={addOpen} onClose={() => setAddOpen(false)} onAdded={(s) => afterNewTiles(s, "Tile added")} />
      <ConfirmDialog
        open={confirmRedesign}
        title="Redesign this dashboard?"
        body={<p>The AI designs a new layout from scratch. Your current tiles, including pinned and added ones, are replaced. This takes 1–2 minutes on a local model.</p>}
        confirmLabel="Redesign"
        onClose={() => setConfirmRedesign(false)}
        onConfirm={() => {
          setConfirmRedesign(false);
          runDesign();
        }}
      />
    </div>
  );
}

/** P4: the dashboard title renames inline — click it, type, Enter (Escape cancels). */
function EditableTitle({ value }: { value: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(value), [value]);

  const commit = async () => {
    const t = draft.trim();
    if (!t || t === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    setBusy(true);
    try {
      await useDashboard.getState().renameDashboard(t);
      setEditing(false);
    } catch (e) {
      toast(`Couldn't rename: ${describeError(e).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (editing)
    return (
      <input
        className="input dash-title-input"
        aria-label="Dashboard title"
        value={draft}
        autoFocus
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            e.stopPropagation();
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <h2 className="dash-title">
      <button type="button" className="title-btn" onClick={() => setEditing(true)} title="Click to rename">
        {value}
      </button>
    </h2>
  );
}

function DashSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div className="skeleton sk-title" />
      <div className="skeleton sk-line w40" />
      <div className="skeleton-grid mt">
        {[6, 6, 6, 6, 12, 12].map((w, i) => (
          <div key={i} className="card tile" style={{ gridColumn: `span ${w}`, height: w === 6 ? 128 : 296 }}>
            <div className="skeleton sk-line w60" />
            <div className={cx("skeleton", w === 6 ? "sk-kpi" : "sk-block")} />
          </div>
        ))}
      </div>
    </div>
  );
}
