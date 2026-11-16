import { useRef, useState } from "react";
import { Plus, RotateCcw, Sparkles } from "lucide-react";
import { Api, SsePaths, describeError, isAbort, sse } from "../api";
import { KIND_LABEL } from "../heuristics";
import { getActiveFilters } from "../stores/dashboard";
import type { DashboardSpec, SuggestEvent, Tile, TileResult } from "../types";
import { ErrorBox } from "./Feedback";
import { Modal } from "./Modal";
import { ProgressLog } from "./ProgressSteps";
import { ResultView } from "./ResultView";

type Phase =
  | { k: "ask" }
  | { k: "working"; lines: string[]; startedAt: number }
  | { k: "preview"; suggestionId: string; tile: Tile; result: TileResult }
  | { k: "error"; message: string; hint?: string };

const EXAMPLES = ["Revenue by brand as a bar chart", "Margin % by category as a column chart", "Monthly orders as a line chart"];

export function AddTileDialog({ modelId, open, onClose, onAdded }: { modelId: string; open: boolean; onClose: () => void; onAdded: (spec: DashboardSpec) => void }) {
  const [request, setRequest] = useState("");
  const [phase, setPhase] = useState<Phase>({ k: "ask" });
  const [adding, setAdding] = useState(false);
  const ctl = useRef<AbortController | null>(null);

  const close = () => {
    ctl.current?.abort();
    setPhase({ k: "ask" });
    onClose();
  };

  const suggest = async () => {
    const text = request.trim();
    if (!text) return;
    const ac = new AbortController();
    ctl.current = ac;
    setPhase({ k: "working", lines: ["Sending your request to the AI"], startedAt: Date.now() });
    let failure: string | null = null;
    let done: Phase | null = null;
    try {
      await sse<SuggestEvent>(
        SsePaths.suggest(modelId),
        { request: text, filters: getActiveFilters() },
        (ev) => {
          if (ev.type === "progress") setPhase((p) => (p.k === "working" ? { ...p, lines: [...p.lines, ev.text] } : p));
          else if (ev.type === "done") done = { k: "preview", suggestionId: ev.suggestionId, tile: ev.tile, result: ev.result };
          else if (ev.type === "error") failure = ev.error;
        },
        ac.signal,
      );
      if (failure) setPhase({ k: "error", message: failure, hint: "Try rephrasing: name the measure, the breakdown and the chart type." });
      else if (done) setPhase(done);
      else setPhase({ k: "error", message: "The AI finished without suggesting a tile.", hint: "Try again or rephrase the request." });
    } catch (e) {
      if (isAbort(e)) setPhase({ k: "ask" });
      else setPhase({ k: "error", ...describeError(e) });
    }
  };

  const add = async () => {
    if (phase.k !== "preview") return;
    setAdding(true);
    try {
      const spec = await Api.addTile(modelId, phase.suggestionId);
      onAdded(spec);
      setRequest("");
      setPhase({ k: "ask" });
      onClose();
    } catch (e) {
      setPhase({ k: "error", ...describeError(e) });
    } finally {
      setAdding(false);
    }
  };

  const footer =
    phase.k === "preview" ? (
      <>
        <button type="button" className="btn" onClick={() => setPhase({ k: "ask" })}>
          <RotateCcw size={14} aria-hidden /> Try again
        </button>
        <button type="button" className="btn btn-primary" onClick={add} disabled={adding}>
          {adding ? <span className="spinner sm" aria-hidden /> : <Plus size={14} aria-hidden />} Add to dashboard
        </button>
      </>
    ) : phase.k === "ask" || phase.k === "error" ? (
      <>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={suggest} disabled={!request.trim()}>
          <Sparkles size={14} aria-hidden /> {phase.k === "error" ? "Try again" : "Suggest tile"}
        </button>
      </>
    ) : undefined;

  return (
    <Modal open={open} onClose={close} title="Add a tile" subtitle="Describe what you want to see. The AI writes the query, the safety gate checks it, and you preview it before adding." size="lg" footer={footer}>
      {(phase.k === "ask" || phase.k === "error") && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            suggest();
          }}
        >
          <label className="field-label" htmlFor="add-tile-req">
            What should the tile show?
          </label>
          <textarea
            id="add-tile-req"
            className="input textarea"
            rows={3}
            value={request}
            data-autofocus
            placeholder="e.g. margin % by category as a column chart"
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                suggest();
              }
            }}
          />
          <div className="chips-row">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="chip-btn" onClick={() => setRequest(x)}>
                {x}
              </button>
            ))}
          </div>
          {phase.k === "error" && <ErrorBox message={phase.message} hint={phase.hint} />}
        </form>
      )}
      {phase.k === "working" && (
        <ProgressLog lines={phase.lines} running startedAt={phase.startedAt} onCancel={() => ctl.current?.abort()} note="Usually 15–60 s on a local model." />
      )}
      {phase.k === "preview" && (
        <div className="preview">
          <div className="preview-head">
            <div>
              <div className="preview-title">{phase.tile.title}</div>
              {phase.tile.description && <div className="muted small">{phase.tile.description}</div>}
            </div>
            <span className="pill pill-off">
              {KIND_LABEL[phase.tile.kind]} · {phase.tile.size}
            </span>
          </div>
          <div className={`preview-body kind-${phase.tile.kind}`}>
            {phase.result.ok ? (
              <ResultView kind={phase.tile.kind} format={phase.tile.format} columns={phase.result.columns} rows={phase.result.rows} truncated={phase.result.truncated} label={phase.tile.title} />
            ) : (
              <ErrorBox message={phase.result.error ?? "The preview query failed."} hint="Try again with a different wording." />
            )}
          </div>
          <p className="muted small">
            {phase.result.rows.length.toLocaleString()} rows · {phase.result.durationMs} ms · preview only, nothing is saved until you add it.
          </p>
        </div>
      )}
    </Modal>
  );
}
