import { Check, CircleSlash, Square, X } from "lucide-react";
import type { Step } from "../stores/chat";
import { cx, seconds, useNow } from "../util";

/** Live step list for a chat turn (F5.1). The timer and active-step clock keep moving so a long wait never looks stuck. */
export function ProgressSteps({
  steps,
  running,
  startedAt,
  endedAt,
  thinking,
  lastEventAt,
  onStop,
}: {
  steps: Step[];
  running: boolean;
  startedAt: number;
  endedAt?: number;
  thinking?: string;
  lastEventAt: number;
  onStop?: () => void;
}) {
  const now = useNow(running, 200);
  const end = running ? now : endedAt ?? now;
  const quietFor = now - lastEventAt;
  return (
    <div className={cx("psteps", running && "is-running")}>
      <ol className="psteps-list" aria-live="polite" aria-label="Progress">
        {steps.map((s) => (
          <li key={s.id} className={cx("pstep", `is-${s.status}`)}>
            <span className="pstep-icon" aria-hidden>
              {s.status === "done" ? <Check size={12} /> : s.status === "failed" ? <X size={12} /> : s.status === "stopped" ? <CircleSlash size={12} /> : <span className="spinner sm" />}
            </span>
            <span className="pstep-label">{s.label}</span>
            {s.status === "active" && running && <span className="pstep-time">{seconds(now - s.startedAt)}</span>}
            <span className="sr-only">{s.status === "active" ? "in progress" : s.status}</span>
          </li>
        ))}
      </ol>
      {running && thinking && <div className="psteps-thinking" title="The model's reasoning so far">{thinking.slice(-160)}</div>}
      {running && quietFor > 8000 && <div className="psteps-hint">Still working — a local model can take up to a minute for a hard question.</div>}
      <div className="psteps-foot">
        <span className="psteps-elapsed" aria-label="Elapsed time">
          {seconds(end - startedAt)}
        </span>
        {running && onStop && (
          <button type="button" className="btn btn-sm" onClick={onStop}>
            <Square size={11} aria-hidden fill="currentColor" /> Stop
          </button>
        )}
      </div>
    </div>
  );
}

/** A list of server progress lines (design / suggest SSE) with a clock and Cancel. */
export function ProgressLog({ lines, running, startedAt, onCancel, note }: { lines: string[]; running: boolean; startedAt: number; onCancel?: () => void; note?: string }) {
  const now = useNow(running, 250);
  return (
    <div className="plog" aria-live="polite">
      <ol className="psteps-list">
        {lines.map((l, i) => {
          const last = i === lines.length - 1;
          return (
            <li key={i} className={cx("pstep", last && running ? "is-active" : "is-done")}>
              <span className="pstep-icon" aria-hidden>
                {last && running ? <span className="spinner sm" /> : <Check size={12} />}
              </span>
              <span className="pstep-label">{l}</span>
            </li>
          );
        })}
      </ol>
      <div className="psteps-foot">
        <span className="psteps-elapsed">{seconds(now - startedAt)}</span>
        {note && <span className="muted small grow">{note}</span>}
        {running && onCancel && (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
