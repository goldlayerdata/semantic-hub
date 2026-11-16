import { useEffect, useState } from "react";
import { MessageSquare, Sigma, Columns3, Filter as FilterIcon } from "lucide-react";
import { Api, describeError } from "../api";
import { filtersText, formatCompact, formatScalar } from "../format";
import { getActiveFilters } from "../stores/dashboard";
import type { Explain, Tile } from "../types";
import { DaxCode } from "./DaxCode";
import { ErrorBox, Spinner } from "./Feedback";
import { Modal } from "./Modal";
import type { ExplainPoint } from "./ResultView";

export type ExplainTarget = { tile: Tile; point?: ExplainPoint };

/** Builds e.g. `Why is Revenue 1.2M for Computers in "Revenue by category"? (filters: Year = 2025)`. */
export function askWhyPrompt(target: ExplainTarget, filters: string): string {
  const { tile, point } = target;
  const metric = point?.series || tile.title;
  const value = point ? (point.formatted || formatCompact(point.value, tile.format)) : "";
  let q: string;
  if (point?.category) q = `Why is ${metric} ${value} for ${point.category} in "${tile.title}"?`;
  else if (point) q = `Why is ${metric} ${value}${metric !== tile.title ? ` in "${tile.title}"` : ""}?`;
  else q = `What drives "${tile.title}"?`;
  return filters ? `${q} (filters: ${filters})` : q;
}

export function ExplainPanel({ modelId, target, onClose, onAskWhy, filterLabels }: { modelId: string; target: ExplainTarget | null; onClose: () => void; onAskWhy: (prompt: string) => void; filterLabels: (t: string, c: string) => string }) {
  const [data, setData] = useState<Explain | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const tile = target?.tile;

  const load = async () => {
    if (!tile) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      setData(await Api.explain(modelId, tile.id, tile.filterable ? getActiveFilters() : []));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (target) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const activeText = tile?.filterable ? filtersText(getActiveFilters().map((f) => ({ label: filterLabels(f.table, f.column), values: f.values }))) : "";
  const point = target?.point;

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      variant="sheet"
      size="md"
      title={tile ? `How "${tile.title}" is calculated` : "Explain"}
      subtitle={tile?.description}
      footer={
        <button type="button" className="btn btn-primary" onClick={() => target && onAskWhy(askWhyPrompt(target, activeText))}>
          <MessageSquare size={14} aria-hidden /> Ask why
        </button>
      }
    >
      {point && (
        <div className="explain-point" aria-label="Selected data point">
          {point.category && (
            <div>
              <span className="muted small">Category</span>
              <div className="ep-v">{point.category}</div>
            </div>
          )}
          {point.series && (
            <div>
              <span className="muted small">Series</span>
              <div className="ep-v">{point.series}</div>
            </div>
          )}
          <div>
            <span className="muted small">Value</span>
            <div className="ep-v ep-num">{point.formatted || formatScalar(point.value)}</div>
          </div>
        </div>
      )}

      {loading && <Spinner label="Looking up measures and columns…" />}
      {error && <ErrorBox message={error.message} hint={error.hint} onRetry={load} />}

      {data && (
        <div className="explain">
          <section>
            <h3 className="explain-h">
              <Sigma size={14} aria-hidden /> Measures
            </h3>
            {data.measures.length === 0 ? (
              <p className="muted small">No model measures are referenced; the value is computed inside the query.</p>
            ) : (
              <ul className="explain-list">
                {data.measures.map((m) => (
                  <li key={`${m.table}.${m.name}`}>
                    <div className="explain-name">
                      <code className="mono">[{m.name}]</code> <span className="muted small">in {m.table}</span>
                      {m.formatString && <span className="pill pill-off small">{m.formatString}</span>}
                    </div>
                    {m.description ? <p className="explain-desc">{m.description}</p> : <p className="muted small">No description in the model.</p>}
                    {m.expression && <DaxCode code={m.expression} label={`Expression of ${m.name}`} maxHeight={220} />}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.columns.length > 0 && (
            <section>
              <h3 className="explain-h">
                <Columns3 size={14} aria-hidden /> Columns
              </h3>
              <ul className="explain-list compact">
                {data.columns.map((c) => (
                  <li key={`${c.table}.${c.column}`}>
                    <code className="mono">
                      '{c.table}'[{c.column}]
                    </code>
                    {c.description && <span className="explain-desc"> — {c.description}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="explain-h">
              <FilterIcon size={14} aria-hidden /> Filters in effect
            </h3>
            {!data.filterable ? (
              <p className="muted small">This tile has a fixed query and ignores the filter bar.</p>
            ) : data.filters.length === 0 ? (
              <p className="muted small">None — this is the total across the whole model.</p>
            ) : (
              <ul className="explain-list compact">
                {data.filters.map((f) => (
                  <li key={f.label}>
                    <strong>{f.label}</strong> = {f.values.map(formatScalar).join(", ")}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <details className="disclosure">
            <summary>Query that produced it</summary>
            <DaxCode code={data.query} maxHeight={320} />
          </details>
        </div>
      )}
    </Modal>
  );
}
