import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Database, FileBarChart2, LayoutDashboard, Loader2, MonitorUp, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Api, SsePaths, describeError, sse } from "../api";
import { PageActions, usePageTitle } from "../components/AppShell";
import { ErrorBox, Spinner } from "../components/Feedback";
import { ConfirmDialog } from "../components/Modal";
import { plural, timeAgo } from "../format";
import { useHub } from "../stores/hub";
import { toast } from "../stores/ui";
import type { ApproveEvent, Discovered, HubModel } from "../types";
import { cx, useInterval } from "../util";

type StepKey = "connect" | "schema" | "profile";
const STEPS: { key: StepKey; label: string }[] = [
  { key: "connect", label: "Connect to Power BI Desktop" },
  { key: "schema", label: "Read the schema" },
  { key: "profile", label: "Profile the data" },
];
type AddState = { active: StepKey; texts: Partial<Record<StepKey, string>>; status: "running" | "done" | "error"; error?: string; modelId?: string };

function useApprove() {
  const [adding, setAdding] = useState<Record<string, AddState>>({});
  const { loadModels, loadDiscovered } = useHub();
  const add = useCallback(
    async (d: Discovered) => {
      const patch = (p: Partial<AddState>) => setAdding((a) => ({ ...a, [d.key]: { ...(a[d.key] ?? { active: "connect", texts: {}, status: "running" }), ...p } }));
      setAdding((a) => ({ ...a, [d.key]: { active: "connect", texts: {}, status: "running" } }));
      let failed: string | null = null;
      try {
        await sse<ApproveEvent>(SsePaths.approve, { key: d.key }, (ev) => {
          if (ev.type === "progress") setAdding((a) => ({ ...a, [d.key]: { ...a[d.key], active: ev.step, texts: { ...a[d.key]?.texts, [ev.step]: ev.text } } }));
          else if (ev.type === "done") patch({ status: "done", modelId: ev.model?.id });
          else if (ev.type === "error") failed = ev.error;
        });
        if (failed) throw new Error(failed);
        patch({ status: "done" });
        toast(`Added ${d.name} to the hub`, "good");
      } catch (e) {
        const m = describeError(e);
        patch({ status: "error", error: m.message + (m.hint ? ` ${m.hint}` : "") });
      } finally {
        await Promise.all([loadModels(), loadDiscovered()]);
      }
    },
    [loadModels, loadDiscovered],
  );
  const clear = (key: string) => setAdding((a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== key)));
  return { adding, add, clear };
}

export function HubPage() {
  usePageTitle("Hub");
  const { models, modelsLoaded, modelsError, discovered, discoveredLoaded, discoveredError, loadModels, loadDiscovered } = useHub();
  const approve = useApprove();
  const [refreshing, setRefreshing] = useState(false);

  useInterval(() => {
    loadDiscovered();
  }, 5000);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadModels(), loadDiscovered()]);
    setRefreshing(false);
  };

  const showGuide = modelsLoaded && !modelsError && !models.some((m) => m.hasDashboard);
  const notInHub = discovered.filter((d) => !d.hubId);

  return (
    <div className="page hub-page">
      <PageActions>
        <button type="button" className="btn" onClick={refresh} disabled={refreshing}>
          <RefreshCw size={14} aria-hidden className={cx(refreshing && "spin")} />
          Refresh
        </button>
      </PageActions>

      <div className="page-intro">
        <h2 className="page-heading">Your semantic models</h2>
        <p className="muted">Power BI models open on this PC, turned into live dashboards you can question in plain language. Every number comes from a read-only DAX query.</p>
      </div>

      {showGuide && <FirstRunGuide models={models} discovered={discovered} discoveredLoaded={discoveredLoaded} approve={approve} />}

      {modelsError && <ErrorBox message={modelsError} hint="The model list couldn't be loaded." onRetry={loadModels} />}

      {!modelsLoaded ? (
        <div className="card-grid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card model-card">
              <div className="skeleton sk-line w60" />
              <div className="skeleton sk-line w40" />
              <div className="skeleton sk-block" />
            </div>
          ))}
        </div>
      ) : (
        models.length > 0 && (
          <section aria-labelledby="models-h">
            <h3 id="models-h" className="section-title">
              In the hub <span className="count">{models.length}</span>
            </h3>
            <div className="card-grid">
              {models.map((m) => (
                <ModelCard key={m.id} model={m} />
              ))}
            </div>
          </section>
        )
      )}

      <section aria-labelledby="disc-h" className="discovered">
        <h3 id="disc-h" className="section-title">
          Open in Power BI Desktop {discoveredLoaded && <span className="count">{discovered.length}</span>}
        </h3>
        {discoveredError && <ErrorBox compact message={discoveredError} hint="Retrying every few seconds." />}
        {!discoveredLoaded ? (
          <Spinner label="Looking for open Power BI Desktop files…" />
        ) : discovered.length === 0 ? (
          <p className="muted">No Power BI Desktop files are open. Open a .pbix in Power BI Desktop and it appears here within a few seconds.</p>
        ) : (
          <ul className="disc-list">
            {discovered.map((d) => (
              <DiscoveredRow key={d.key} d={d} state={approve.adding[d.key]} onAdd={() => approve.add(d)} onDismiss={() => approve.clear(d.key)} />
            ))}
          </ul>
        )}
        {discoveredLoaded && notInHub.length === 0 && discovered.length > 0 && <p className="muted small">Everything open in Desktop is already in the hub.</p>}
      </section>
    </div>
  );
}

function DiscoveredRow({ d, state, onAdd, onDismiss }: { d: Discovered; state?: AddState; onAdd: () => void; onDismiss: () => void }) {
  const navigate = useNavigate();
  return (
    <li className="disc-row">
      <div className="disc-main">
        <FileBarChart2 size={18} aria-hidden className="muted" />
        <div className="disc-text">
          <div className="disc-name">{d.name}</div>
          <div className="disc-path" title={d.sourcePath}>
            {d.sourcePath}
          </div>
        </div>
        {d.hubId ? (
          <button type="button" className="btn btn-sm" onClick={() => navigate(`/models/${encodeURIComponent(d.hubId!)}`)}>
            <Check size={14} aria-hidden /> In hub · Open
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={onAdd} disabled={state?.status === "running"}>
            {state?.status === "running" ? <Loader2 size={14} className="spin" aria-hidden /> : <Plus size={14} aria-hidden />}
            {state?.status === "running" ? "Adding…" : "Add"}
          </button>
        )}
      </div>
      {state && <AddProgress state={state} onDismiss={onDismiss} />}
    </li>
  );
}

function AddProgress({ state, onDismiss }: { state: AddState; onDismiss: () => void }) {
  const activeIdx = STEPS.findIndex((s) => s.key === state.active);
  return (
    <div className="add-progress" aria-live="polite">
      <ol className="steps-inline">
        {STEPS.map((s, i) => {
          const st = state.status === "done" || i < activeIdx ? "done" : i === activeIdx ? (state.status === "error" ? "failed" : "active") : "pending";
          return (
            <li key={s.key} className={cx("step-inline", `is-${st}`)}>
              <span className="step-icon" aria-hidden>
                {st === "done" ? <Check size={12} /> : st === "active" ? <span className="spinner sm" /> : st === "failed" ? <X size={12} /> : null}
              </span>
              <span>
                {s.label}
                {state.texts[s.key] && st === "active" && <span className="muted"> · {state.texts[s.key]}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {state.status === "error" && (
        <div className="add-error">
          <ErrorBox compact message={state.error ?? "Adding the model failed."} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function FirstRunGuide({
  models,
  discovered,
  discoveredLoaded,
  approve,
}: {
  models: HubModel[];
  discovered: Discovered[];
  discoveredLoaded: boolean;
  approve: ReturnType<typeof useApprove>;
}) {
  const navigate = useNavigate();
  const step1 = discovered.length > 0 || models.length > 0;
  const step2 = models.length > 0;
  const first = models[0];
  const candidates = discovered.filter((d) => !d.hubId);
  const current = !step1 ? 1 : !step2 ? 2 : 3;

  return (
    <section className="card guide" aria-labelledby="guide-h">
      <h3 id="guide-h">Get to your first dashboard in three steps</h3>
      <ol className="guide-steps">
        <li className={cx("guide-step", step1 ? "is-done" : current === 1 && "is-current")}>
          <span className="guide-num" aria-hidden>
            {step1 ? <Check size={14} /> : 1}
          </span>
          <div>
            <div className="guide-title">
              Open a .pbix in Power BI Desktop {step1 && <span className="sr-only">(done)</span>}
            </div>
            <div className="guide-text">
              {step1 ? (
                `Found ${plural(discovered.length || models.length, "model")} on this PC.`
              ) : (
                <>
                  <Spinner /> {discoveredLoaded ? "Waiting for Power BI Desktop… this checks every 5 seconds." : "Looking…"}
                </>
              )}
            </div>
          </div>
        </li>
        <li className={cx("guide-step", step2 ? "is-done" : current === 2 && "is-current")}>
          <span className="guide-num" aria-hidden>
            {step2 ? <Check size={14} /> : 2}
          </span>
          <div className="grow">
            <div className="guide-title">Add it to the hub</div>
            <div className="guide-text">
              {step2 ? `${first?.name} is in the hub.` : "The app connects, reads the schema and profiles the data. Nothing leaves this PC."}
            </div>
            {!step2 && candidates.length > 0 && (
              <ul className="disc-list compact">
                {candidates.slice(0, 3).map((d) => (
                  <DiscoveredRow key={d.key} d={d} state={approve.adding[d.key]} onAdd={() => approve.add(d)} onDismiss={() => approve.clear(d.key)} />
                ))}
              </ul>
            )}
          </div>
        </li>
        <li className={cx("guide-step", current === 3 && "is-current")}>
          <span className="guide-num" aria-hidden>
            3
          </span>
          <div className="grow">
            <div className="guide-title">Open its dashboard</div>
            <div className="guide-text">The AI designs a dashboard from the model (1–2 minutes on a local model), then you can filter it and ask questions.</div>
            {step2 && first && (
              <button type="button" className="btn btn-primary" onClick={() => navigate(`/models/${encodeURIComponent(first.id)}`, { state: { design: !first.hasDashboard } })}>
                <LayoutDashboard size={14} aria-hidden />
                {first.hasDashboard ? "Open dashboard" : "Create dashboard"}
              </button>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
}

function pct(n: number, of: number) {
  return of > 0 ? Math.round((n / of) * 100) : 100;
}

function ModelCard({ model: m }: { model: HubModel }) {
  const navigate = useNavigate();
  const { loadModels } = useHub();
  const [refreshing, setRefreshing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const h = m.health;
  const measuresPct = h ? pct(h.measures - h.measuresWithoutDescription, h.measures) : null;
  const colsPct = h ? pct(h.visibleColumns - h.columnsWithoutDescription, h.visibleColumns) : null;

  const refreshSchema = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await Api.refreshSchema(m.id);
      await loadModels();
      toast(`Schema of ${m.name} re-read`, "good");
    } catch (e) {
      const d = describeError(e);
      setError(d.message + (d.hint ? ` ${d.hint}` : m.online ? "" : " The model is offline: open it in Power BI Desktop first."));
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await Api.removeModel(m.id);
      setConfirm(false);
      await loadModels();
      toast(`Removed ${m.name} from the hub`);
    } catch (e) {
      setError(describeError(e).message);
      setConfirm(false);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <article className="card model-card" aria-labelledby={`mc-${m.id}`}>
      <header className="mc-head">
        <div className="mc-icon" aria-hidden>
          <Database size={18} />
        </div>
        <div className="mc-titles">
          <h4 id={`mc-${m.id}`}>{m.name}</h4>
          <div className="mc-path" title={m.sourcePath}>
            {m.sourcePath}
          </div>
        </div>
        <span className={cx("pill", m.online ? "pill-good" : "pill-off")}>
          <span className={cx("dot", m.online ? "dot-good" : "dot-off")} aria-hidden />
          {m.online ? "Online" : "Offline"}
        </span>
      </header>

      <div className="mc-stats">
        {m.counts ? (
          <>
            <Stat n={m.counts.tables} label="tables" />
            <Stat n={m.counts.columns} label="columns" />
            <Stat n={m.counts.measures} label="measures" />
          </>
        ) : (
          <span className="muted small">Schema not read yet</span>
        )}
      </div>

      {h && (
        <div className="mc-health" aria-label="Description health">
          <div className="mc-health-title">Description coverage</div>
          <Meter label="Measures" value={measuresPct!} />
          <Meter label="Columns" value={colsPct!} />
          {h.tablesWithoutDescription > 0 && <div className="small muted">{plural(h.tablesWithoutDescription, "table")} without a description</div>}
        </div>
      )}

      <div className="mc-meta small muted">
        <span>Schema read {timeAgo(m.schemaHarvestedAt)}</span>
        <span aria-hidden>·</span>
        <span>{m.hasDashboard ? "Dashboard ready" : "No dashboard yet"}</span>
      </div>

      {error && <ErrorBox compact message={error} />}

      <footer className="mc-actions">
        <button
          type="button"
          className={cx("btn", "btn-primary")}
          onClick={() => navigate(`/models/${encodeURIComponent(m.id)}`, { state: { design: !m.hasDashboard } })}
        >
          <LayoutDashboard size={14} aria-hidden />
          {m.hasDashboard ? "Open dashboard" : "Create dashboard"}
        </button>
        <div className="grow" />
        <button type="button" className="icon-btn" onClick={refreshSchema} disabled={refreshing} aria-label={`Re-read the schema of ${m.name}`} title="Re-read schema">
          <RefreshCw size={15} className={cx(refreshing && "spin")} aria-hidden />
        </button>
        <button type="button" className="icon-btn danger" onClick={() => setConfirm(true)} aria-label={`Remove ${m.name} from the hub`} title="Remove from hub">
          <Trash2 size={15} aria-hidden />
        </button>
      </footer>
      {!m.online && (
        <div className="mc-offline small">
          <MonitorUp size={14} aria-hidden /> Open the .pbix in Power BI Desktop to bring it online.
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        title={`Remove ${m.name}?`}
        body={
          <p>
            This removes the model, its dashboard and saved schema from the hub. The .pbix file and Power BI Desktop are not touched. You can add it again later.
          </p>
        }
        confirmLabel="Remove"
        danger
        busy={removing}
        onConfirm={remove}
        onClose={() => setConfirm(false)}
      />
    </article>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="stat">
      <span className="stat-n">{n.toLocaleString()}</span>
      <span className="stat-l">{label}</span>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  const tone = value >= 80 ? "good" : value >= 40 ? "warn" : "bad";
  return (
    <div className="meter-row">
      <span className="meter-label">{label}</span>
      <div className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} described`}>
        <div className={cx("meter-fill", `is-${tone}`)} style={{ width: `${value}%` }} />
      </div>
      <span className="meter-value">{value}%</span>
    </div>
  );
}
