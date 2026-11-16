import { useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Check, Info, Pin } from "lucide-react";
import { Api, describeError } from "../api";
import { guessFormat, plural } from "../format";
import { KIND_LABEL, pickKind, validKinds } from "../heuristics";
import type { AssistantMessage } from "../stores/chat";
import type { DashboardSpec, TileKind } from "../types";
import { cx, seconds } from "../util";
import { DaxCode } from "./DaxCode";
import { ErrorBox, Segmented } from "./Feedback";
import { ProgressSteps } from "./ProgressSteps";
import { ResultView } from "./ResultView";

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function AnswerCard({
  msg,
  modelId,
  conversationId,
  onStop,
  onPinned,
  canPin,
}: {
  msg: AssistantMessage;
  modelId: string;
  conversationId: string | null;
  onStop: () => void;
  onPinned: (spec: DashboardSpec, title: string) => void;
  canPin: boolean;
}) {
  const running = msg.status === "running";
  const a = msg.answer;
  const kinds = useMemo(() => (a ? validKinds(a.columns, a.rows) : []), [a]);
  const [kind, setKind] = useState<TileKind | null>(null);
  const shownKind: TileKind = kind ?? (a ? pickKind(a.columns, a.rows) : "table");
  const format = useMemo(() => (a ? guessFormat(a.columns, a.rows) : "number"), [a]);
  const queries = msg.tools.filter((t) => t.tool === "run_dax");
  const elapsed = (msg.endedAt ?? Date.now()) - msg.startedAt;

  return (
    <article className={cx("answer", `is-${msg.status}`)} aria-busy={running}>
      {(running || msg.status === "stopped" || (msg.status === "error" && !msg.text)) && (
        <ProgressSteps steps={msg.steps} running={running} startedAt={msg.startedAt} endedAt={msg.endedAt} thinking={msg.thinking} lastEventAt={msg.lastEventAt} onStop={onStop} />
      )}
      {msg.status === "stopped" && <div className="answer-stopped">Stopped. Nothing from this turn was kept.</div>}

      {msg.text && <Markdown text={msg.text} />}

      {msg.notices.map((n, i) => (
        <div key={i} className="notice">
          <Info size={13} aria-hidden /> {n}
        </div>
      ))}

      {msg.error && <ErrorBox compact message={msg.error} hint={msg.hint ?? "Try rephrasing the question, or start a new chat."} />}

      {a && a.rows.length > 0 && (
        <div className="answer-data">
          <div className="answer-data-head">
            <Segmented<TileKind> label="Show answer as" size="sm" value={shownKind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          </div>
          <div className={cx("answer-visual", `kind-${shownKind}`)}>
            <ResultView kind={shownKind} format={format} columns={a.columns} rows={a.rows} truncated={a.truncated} label={msg.question} density="sm" />
          </div>
          {canPin && conversationId && msg.status === "done" && (
            <PinBar modelId={modelId} conversationId={conversationId} toolId={a.toolId} question={msg.question} kind={shownKind} format={format} pinnedTitle={msg.pinnedTitle} onPinned={onPinned} />
          )}
        </div>
      )}

      {!running && (msg.tools.length > 0 || msg.usage) && (
        <details className="disclosure how">
          <summary>How I got this</summary>
          <div className="how-body">
            <dl className="kv">
              <dt>Model</dt>
              <dd>{msg.modelName}</dd>
              <dt>Filters</dt>
              <dd>{msg.filtersText || "None"}</dd>
              <dt>AI</dt>
              <dd>
                {msg.usage ? `${msg.usage.model}${msg.usage.provider === "local" ? " (local)" : ""}` : "—"} · {plural(msg.usage?.toolCalls ?? msg.tools.length, "tool call")} · {seconds(elapsed)}
              </dd>
            </dl>
            {queries.map((q, i) => (
              <div key={q.toolId} className="how-query">
                <div className="how-query-head">
                  <span>Query {i + 1}</span>
                  <span className={cx("badge", q.ok ? "badge-good" : q.rejected ? "badge-warn" : q.ok === false ? "badge-bad" : "badge-off")}>
                    {q.ok ? "ok" : q.rejected ? "blocked" : q.ok === false ? "failed" : "—"}
                  </span>
                  {q.ok && (
                    <span className="muted small">
                      {plural(q.rows ?? 0, "row")}
                      {q.truncated ? " (capped)" : ""} · {q.durationMs ?? 0} ms
                    </span>
                  )}
                </div>
                {q.dax && <DaxCode code={q.dax} maxHeight={220} />}
                {q.error && <div className="small bad-text">{q.error}</div>}
              </div>
            ))}
          </div>
        </details>
      )}
    </article>
  );
}

function PinBar({
  modelId,
  conversationId,
  toolId,
  question,
  kind,
  format,
  pinnedTitle,
  onPinned,
}: {
  modelId: string;
  conversationId: string;
  toolId: string;
  question: string;
  kind: TileKind;
  format: string;
  pinnedTitle?: string;
  onPinned: (spec: DashboardSpec, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(question.replace(/\?+$/, "").slice(0, 80));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pinnedTitle)
    return (
      <div className="pin-done small">
        <Check size={14} aria-hidden /> Pinned to the dashboard as “{pinnedTitle}”.
      </div>
    );

  if (!editing)
    return (
      <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
        <Pin size={13} aria-hidden /> Pin to dashboard
      </button>
    );

  const pin = async () => {
    setBusy(true);
    setError(null);
    try {
      const spec = await Api.pin(modelId, { conversationId, toolId, title: title.trim() || question, kind, format });
      onPinned(spec, title.trim() || question);
    } catch (e) {
      const d = describeError(e);
      setError(d.message + (d.hint ? ` ${d.hint}` : ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="pin-form"
      onSubmit={(e) => {
        e.preventDefault();
        pin();
      }}
    >
      <label className="sr-only" htmlFor={`pin-${toolId}`}>
        Tile title
      </label>
      <input id={`pin-${toolId}`} className="input input-sm" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
        {busy ? <span className="spinner sm" aria-hidden /> : <Pin size={13} aria-hidden />} Pin as {KIND_LABEL[kind].toLowerCase()}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error && <ErrorBox compact message={error} />}
    </form>
  );
}
