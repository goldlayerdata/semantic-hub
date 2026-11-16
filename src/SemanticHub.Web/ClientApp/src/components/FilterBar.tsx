import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Filter, Plus, Search, X } from "lucide-react";
import { Api, describeError } from "../api";
import { formatScalar } from "../format";
import { filterKey, useActiveFilters, useDashboard } from "../stores/dashboard";
import { toast } from "../stores/ui";
import type { FilterColumn, FilterDef, FilterValue, Scalar } from "../types";
import { cx } from "../util";
import { ErrorBox, Spinner } from "./Feedback";
import { Popover } from "./Popover";

const same = (a: Scalar, b: Scalar) => a === b || (a != null && b != null && String(a) === String(b));

export function FilterBar({ modelId, defs, disabled }: { modelId: string; defs: FilterDef[]; disabled?: boolean }) {
  const active = useActiveFilters();
  const setFilters = useDashboard((s) => s.setFilters);
  const saveFilterDefs = useDashboard((s) => s.saveFilterDefs);
  const labelOf = (f: { table: string; column: string }) => defs.find((d) => filterKey(d) === filterKey(f))?.label ?? f.column;

  const apply = (def: FilterDef, values: Scalar[]) => {
    const rest = active.filter((f) => filterKey(f) !== filterKey(def));
    setFilters(values.length ? [...rest, { table: def.table, column: def.column, values }] : rest);
  };

  const removeDef = async (def: FilterDef) => {
    try {
      await saveFilterDefs(defs.filter((d) => filterKey(d) !== filterKey(def)));
      toast(`Removed the ${def.label} filter`);
    } catch (e) {
      toast(`Couldn't remove the filter: ${describeError(e).message}`, "error");
    }
  };

  return (
    <div className="filterbar" role="region" aria-label="Dashboard filters">
      <div className="filterbar-row">
        <Filter size={14} aria-hidden className="muted" />
        {defs.length === 0 && <span className="muted small">No filters yet.</span>}
        {defs.map((d) => (
          <FilterDropdown
            key={filterKey(d)}
            def={d}
            selected={active.find((f) => filterKey(f) === filterKey(d))?.values ?? []}
            onApply={(v) => apply(d, v)}
            onRemoveDef={() => removeDef(d)}
            disabled={disabled}
          />
        ))}
        <AddFilter modelId={modelId} defs={defs} onAdd={(def) => saveFilterDefs([...defs, def])} disabled={disabled} />
      </div>
      {active.length > 0 && (
        <div className="filterbar-chips" aria-label="Active filters">
          {active.map((f) => (
            <ActiveChip key={filterKey(f)} f={f} label={labelOf(f)} onRemove={() => setFilters(active.filter((x) => filterKey(x) !== filterKey(f)))} />
          ))}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilters([])}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

function ActiveChip({ f, label, onRemove }: { f: FilterValue; label: string; onRemove: () => void }) {
  const shown = f.values.slice(0, 3).map(formatScalar).join(", ") + (f.values.length > 3 ? ` +${f.values.length - 3}` : "");
  return (
    <span className="chip">
      <span className="chip-label">{label}:</span> <span>{shown}</span>
      <button type="button" className="chip-x" onClick={onRemove} aria-label={`Remove filter ${label}`}>
        <X size={12} aria-hidden />
      </button>
    </span>
  );
}

function FilterDropdown({ def, selected, onApply, onRemoveDef, disabled }: { def: FilterDef; selected: Scalar[]; onApply: (v: Scalar[]) => void; onRemoveDef: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Scalar[]>(selected);
  const [q, setQ] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const key = filterKey(def);
  const values = useDashboard((s) => s.values[key]);
  const loadValues = useDashboard((s) => s.loadValues);

  useEffect(() => {
    if (open) {
      setDraft(selected);
      setQ("");
      loadValues(def.table, def.column);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const list = values?.status === "ok" ? values.data.values : [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((v) => formatScalar(v).toLowerCase().includes(needle)) : list;
  }, [list, q]);

  const toggle = (v: Scalar) => setDraft((d) => (d.some((x) => same(x, v)) ? d.filter((x) => !same(x, v)) : [...d, v]));
  const changed = draft.length !== selected.length || draft.some((v) => !selected.some((s) => same(s, v)));
  const close = (applyChanges: boolean) => {
    setOpen(false);
    if (applyChanges && changed) onApply(draft);
  };

  const summary = selected.length === 0 ? "All" : selected.length === 1 ? formatScalar(selected[0]) : `${selected.length} selected`;

  return (
    <div className="menu-wrap">
      <button
        ref={btn}
        type="button"
        className={cx("filter-btn", selected.length > 0 && "is-active")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}
        disabled={disabled}
      >
        <span className="filter-btn-label">{def.label}</span>
        <span className="filter-btn-value">{summary}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      <Popover open={open} onClose={() => close(true)} className="filter-pop" label={`Filter by ${def.label}`} triggerRef={btn}>
        <div className="filter-search">
          <Search size={14} aria-hidden className="muted" />
          <input className="input-bare" placeholder={`Search ${def.label}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${def.label} values`} autoFocus />
        </div>
        <div className="filter-values" role="group" aria-label={`${def.label} values`}>
          {!values || values.status === "loading" ? (
            <div className="pad">
              <Spinner label="Loading values…" />
            </div>
          ) : values.status === "error" ? (
            <div className="pad">
              <ErrorBox compact message={values.error} onRetry={() => loadValues(def.table, def.column)} />
            </div>
          ) : shown.length === 0 ? (
            <div className="pad muted small">No matching values.</div>
          ) : (
            shown.map((v, i) => {
              const checked = draft.some((x) => same(x, v));
              return (
                <label key={i} className={cx("check-row", checked && "is-checked")}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(v)} />
                  <span>{formatScalar(v)}</span>
                </label>
              );
            })
          )}
          {values?.status === "ok" && values.data.truncated && <div className="pad muted small">Showing the first {list.length} values. Search to narrow down.</div>}
        </div>
        <div className="filter-foot">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRemoveDef} title="Remove this filter from the bar">
            Remove filter
          </button>
          <div className="grow" />
          <button type="button" className="btn btn-sm" onClick={() => setDraft([])} disabled={!draft.length}>
            Clear
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => close(true)}>
            Apply
          </button>
        </div>
      </Popover>
    </div>
  );
}

function AddFilter({ modelId, defs, onAdd, disabled }: { modelId: string; defs: FilterDef[]; onAdd: (d: FilterDef) => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState<FilterColumn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);

  const load = async () => {
    setError(null);
    try {
      setCols((await Api.filterColumns(modelId)) ?? []);
    } catch (e) {
      setError(describeError(e).message);
    }
  };
  useEffect(() => {
    if (open && !cols) load();
    if (open) setQ("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const taken = new Set(defs.map(filterKey));
  const shown = (cols ?? []).filter((c) => !taken.has(filterKey(c)) && `${c.label} ${c.table} ${c.column}`.toLowerCase().includes(q.trim().toLowerCase()));

  const pick = async (c: FilterColumn) => {
    setSaving(filterKey(c));
    try {
      await onAdd({ table: c.table, column: c.column, label: c.label || c.column });
      setOpen(false);
      toast(`Added the ${c.label || c.column} filter`, "good");
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="menu-wrap">
      <button ref={btn} type="button" className="btn btn-sm btn-ghost" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <Plus size={14} aria-hidden /> Filter
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="filter-pop" label="Add a filter" triggerRef={btn}>
        <div className="filter-search">
          <Search size={14} aria-hidden className="muted" />
          <input className="input-bare" placeholder="Find a column" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a column to filter by" autoFocus />
        </div>
        <div className="filter-values">
          {error ? (
            <div className="pad">
              <ErrorBox compact message={error} onRetry={load} />
            </div>
          ) : !cols ? (
            <div className="pad">
              <Spinner label="Loading columns…" />
            </div>
          ) : shown.length === 0 ? (
            <div className="pad muted small">No more columns to add.</div>
          ) : (
            shown.map((c) => (
              <button key={filterKey(c)} type="button" className="pick-row" onClick={() => pick(c)} disabled={!!saving}>
                <span className="pick-main">{c.label || c.column}</span>
                <span className="pick-sub">
                  {c.table} · {c.dataType}
                </span>
                {saving === filterKey(c) && <span className="spinner sm" aria-hidden />}
              </button>
            ))
          )}
        </div>
      </Popover>
    </div>
  );
}
