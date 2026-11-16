import { useEffect, useMemo, useState } from "react";
import { ChevronRight, MessageSquare, RefreshCw, Search } from "lucide-react";
import { Api, describeError } from "../api";
import { PageActions, usePageTitle } from "../components/AppShell";
import { DaxCode } from "../components/DaxCode";
import { EmptyState, ErrorBox, Spinner } from "../components/Feedback";
import { plural } from "../format";
import { useHub } from "../stores/hub";
import type { AuditEntry } from "../types";
import { cx } from "../util";

type Outcome = "ok" | "failed" | "blocked";
const SOURCES: AuditEntry["source"][] = ["agent", "dashboard", "designer", "schema"];
const OUTCOMES: Outcome[] = ["ok", "failed", "blocked"];
const outcomeOf = (e: AuditEntry): Outcome => (e.rejected ? "blocked" : e.error ? "failed" : "ok");

type Group = { key: string; conversation: boolean; header: string | null; entries: AuditEntry[] };

const dtf = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtf.format(d);
};

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  return n;
}

export function AuditPage() {
  usePageTitle("Audit");
  const models = useHub((s) => s.models);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [sources, setSources] = useState<Set<AuditEntry["source"]>>(new Set());
  const [outcomes, setOutcomes] = useState<Set<Outcome>>(new Set());
  const [modelIds, setModelIds] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(150);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries((await Api.audit(1000)) ?? []);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const nameOf = (id: string | null) => (id ? models.find((m) => m.id === id)?.name ?? id : "—");
  const modelOptions = useMemo(() => Array.from(new Set((entries ?? []).map((e) => e.modelId).filter((x): x is string => !!x))), [entries]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (entries ?? []).filter(
      (e) =>
        (!sources.size || sources.has(e.source)) &&
        (!outcomes.size || outcomes.has(outcomeOf(e))) &&
        (!modelIds.size || (e.modelId && modelIds.has(e.modelId))) &&
        (!needle || [e.question, e.dax, e.error, e.note].some((s) => s?.toLowerCase().includes(needle))),
    );
  }, [entries, q, sources, outcomes, modelIds]);

  const groups = useMemo(() => {
    const out: Group[] = [];
    const byConv = new Map<string, Group>();
    for (const e of filtered) {
      if (e.source === "agent" && e.conversationId) {
        let g = byConv.get(e.conversationId);
        if (!g) {
          g = { key: `c:${e.conversationId}`, conversation: true, header: null, entries: [] };
          byConv.set(e.conversationId, g);
          out.push(g);
        }
        g.entries.push(e);
      } else out.push({ key: `e:${out.length}:${e.at}`, conversation: false, header: null, entries: [e] });
    }
    // Newest first, so the conversation's first question is the last one that has a question.
    for (const g of byConv.values()) g.header = [...g.entries].reverse().find((e) => e.question)?.question ?? "Conversation";
    return out;
  }, [filtered]);

  const counts = useMemo(() => {
    const c = { ok: 0, failed: 0, blocked: 0 } as Record<Outcome, number>;
    for (const e of entries ?? []) c[outcomeOf(e)]++;
    return c;
  }, [entries]);

  const anyFilter = q || sources.size || outcomes.size || modelIds.size;

  return (
    <div className="page audit-page">
      <PageActions>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          <RefreshCw size={14} aria-hidden className={cx(loading && "spin")} /> Refresh
        </button>
      </PageActions>

      <div className="page-intro">
        <h2 className="page-heading">Audit log</h2>
        <p className="muted">
          Every query that touched a model — from the AI, dashboards, the designer and schema reads — passes the read-only gate and is recorded here.
          {entries && (
            <>
              {" "}
              Last {plural(entries.length, "entry", "entries")}: {counts.ok} ok, {counts.failed} failed, {counts.blocked} blocked.
            </>
          )}
        </p>
      </div>

      <div className="audit-tools card">
        <div className="search">
          <Search size={15} aria-hidden className="muted" />
          <input className="input-bare" type="search" placeholder="Search questions, DAX or errors" aria-label="Search the audit log" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="facets">
          <Facet label="Source" options={SOURCES} selected={sources} onToggle={(v) => setSources((s) => toggle(s, v))} />
          <Facet label="Outcome" options={OUTCOMES} selected={outcomes} onToggle={(v) => setOutcomes((s) => toggle(s, v))} />
          {modelOptions.length > 1 && <Facet label="Model" options={modelOptions} selected={modelIds} onToggle={(v) => setModelIds((s) => toggle(s, v))} render={nameOf} />}
          {anyFilter ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setQ("");
                setSources(new Set());
                setOutcomes(new Set());
                setModelIds(new Set());
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {error && <ErrorBox message={error.message} hint={error.hint} onRetry={load} />}
      {!entries && !error && <Spinner label="Loading the audit log…" />}

      {entries && (
        <>
          <p className="small muted" aria-live="polite">
            {anyFilter ? `${plural(filtered.length, "entry", "entries")} match` : `${plural(entries.length, "entry", "entries")}`}
          </p>
          {groups.length === 0 ? (
            <EmptyState title={entries.length ? "Nothing matches" : "No queries yet"}>
              {entries.length ? "Try a different search or clear the filters." : "Queries appear here once a dashboard runs or someone asks a question."}
            </EmptyState>
          ) : (
            <div className="audit-list">
              <div className="audit-row audit-header" aria-hidden>
                <span />
                <span>Time</span>
                <span>Source</span>
                <span>Model</span>
                <span className="num">Rows</span>
                <span className="num">ms</span>
                <span>Outcome</span>
              </div>
              {groups.slice(0, limit).map((g) =>
                g.conversation ? (
                  <section key={g.key} className="audit-group" aria-label={`Conversation: ${g.header}`}>
                    <div className="audit-group-head">
                      <MessageSquare size={14} aria-hidden />
                      <span className="audit-q">{g.header}</span>
                      <span className="muted small">{plural(g.entries.length, "query", "queries")}</span>
                    </div>
                    {g.entries.map((e, i) => (
                      <AuditRow key={i} e={e} model={nameOf(e.modelId)} showQuestion={g.entries.length > 1 && !!e.question && e.question !== g.header} />
                    ))}
                  </section>
                ) : (
                  <AuditRow key={g.key} e={g.entries[0]} model={nameOf(g.entries[0].modelId)} showQuestion={!!g.entries[0].question} />
                ),
              )}
              {groups.length > limit && (
                <button type="button" className="btn audit-more" onClick={() => setLimit((l) => l + 300)}>
                  Show more ({groups.length - limit} more groups)
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Facet<T extends string>({ label, options, selected, onToggle, render }: { label: string; options: T[]; selected: Set<T>; onToggle: (v: T) => void; render?: (v: T) => string }) {
  return (
    <div className="facet" role="group" aria-label={label}>
      <span className="facet-label">{label}</span>
      {options.map((o) => (
        <button key={o} type="button" className={cx("facet-chip", selected.has(o) && "is-on")} aria-pressed={selected.has(o)} onClick={() => onToggle(o)}>
          {render ? render(o) : o}
        </button>
      ))}
    </div>
  );
}

function AuditRow({ e, model, showQuestion }: { e: AuditEntry; model: string; showQuestion: boolean }) {
  const [open, setOpen] = useState(false);
  const outcome = outcomeOf(e);
  const expandable = !!(e.dax || e.error || e.note);
  return (
    <div className={cx("audit-item", open && "is-open")}>
      <button type="button" className="audit-row" onClick={() => expandable && setOpen((o) => !o)} aria-expanded={expandable ? open : undefined} disabled={!expandable}>
        <span className="audit-chev" aria-hidden>
          {expandable && <ChevronRight size={14} />}
        </span>
        <span className="audit-time">{fmtTime(e.at)}</span>
        <span>
          <span className={cx("badge", `src-${e.source}`)}>{e.source}</span>
        </span>
        <span className="audit-model" title={model}>
          {model}
        </span>
        <span className="num">{e.rows != null ? `${e.rows.toLocaleString()}${e.truncated ? "+" : ""}` : "—"}</span>
        <span className="num">{e.durationMs != null ? e.durationMs.toLocaleString() : "—"}</span>
        <span>
          <span className={cx("badge", outcome === "ok" ? "badge-good" : outcome === "blocked" ? "badge-warn" : "badge-bad")}>{outcome}</span>
        </span>
      </button>
      {showQuestion && <div className="audit-sub">“{e.question}”</div>}
      {open && (
        <div className="audit-detail">
          {e.error && <div className="audit-error">{e.error}</div>}
          {e.note && <div className="small muted">{e.note}</div>}
          {e.dax && <DaxCode code={e.dax} maxHeight={360} />}
        </div>
      )}
    </div>
  );
}
