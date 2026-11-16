import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Cpu, Monitor, Moon, Sun } from "lucide-react";
import { useHub } from "../stores/hub";
import { useTheme, useUi, type ThemeMode } from "../stores/ui";
import { cx } from "../util";
import { Segmented } from "./Feedback";
import { Popover } from "./Popover";

export function TopBar({ actionsRef }: { actionsRef: (el: HTMLElement | null) => void }) {
  const title = useUi((s) => s.pageTitle);
  const crumb = useUi((s) => s.crumb);
  return (
    <header className="topbar">
      {crumb ? (
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to={crumb.to} className="crumb-link">
            {crumb.label}
          </Link>
          <ChevronRight size={14} aria-hidden className="crumb-sep" />
          <h1 className="topbar-title" aria-current="page">
            {title}
          </h1>
        </nav>
      ) : (
        <h1 className="topbar-title">{title}</h1>
      )}
      <div className="topbar-actions" ref={actionsRef} />
      <StatusChip />
      <ThemeToggle />
    </header>
  );
}

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <Segmented<ThemeMode>
      label="Colour theme"
      size="sm"
      value={mode}
      onChange={setMode}
      options={[
        { value: "light", label: <Sun size={14} aria-hidden />, title: "Light theme" },
        { value: "dark", label: <Moon size={14} aria-hidden />, title: "Dark theme" },
        { value: "system", label: <Monitor size={14} aria-hidden />, title: "Match system theme" },
      ]}
    />
  );
}

export function StatusChip() {
  const status = useHub((s) => s.status);
  const statusError = useHub((s) => s.statusError);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  let tone: "good" | "warn" | "bad" | "idle" = "idle";
  let text = "Checking AI status…";
  let detail: string | null = null;
  const llm = status?.llm;
  const local = llm?.provider === "local";

  if (statusError && !status) {
    tone = "bad";
    text = "Server not reachable";
    detail = `${statusError} Check that the app is running on this PC.`;
  } else if (llm) {
    const who = local ? `Local · ${llm.model || "model"}` : `Claude · ${llm.model || "model"}`;
    if (!llm.ready) {
      tone = "bad";
      text = local ? `${who} · not ready` : `${who} · not ready`;
      detail = llm.problem || "The AI provider is not ready.";
    } else if (llm.warning) {
      tone = "warn";
      text = `${who} · check`;
      detail = llm.warning;
    } else {
      tone = "good";
      text = local ? `${who} · runs on this PC` : `${who} · cloud`;
    }
  }

  return (
    <div className="status-wrap">
      <button
        ref={btn}
        type="button"
        className={cx("status-chip", `is-${tone}`)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={detail ?? text}
      >
        <span className={cx("dot", tone === "good" ? "dot-good" : tone === "warn" ? "dot-warn" : tone === "bad" ? "dot-bad" : "dot-off")} aria-hidden />
        <span className="status-text">{text}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="end" className="status-pop" label="AI status details" triggerRef={btn}>
        <div className="status-pop-head">
          <Cpu size={16} aria-hidden />
          <strong>{llm ? (local ? "Local AI model" : "Claude (Anthropic API)") : "AI status"}</strong>
        </div>
        {detail && <p className={cx("status-pop-detail", tone === "bad" && "is-bad", tone === "warn" && "is-warn")}>{detail}</p>}
        {llm && (
          <dl className="kv">
            <dt>Model</dt>
            <dd>{llm.model || "—"}</dd>
            <dt>State</dt>
            <dd>{llm.ready ? "Ready" : "Not ready"}</dd>
            {llm.endpoint && (
              <>
                <dt>Endpoint</dt>
                <dd className="mono">{llm.endpoint}</dd>
              </>
            )}
            {status?.limits && (
              <>
                <dt>Limits</dt>
                <dd>
                  {status.limits.maxRows.toLocaleString()} rows · {status.limits.queryTimeoutSeconds} s timeout · {status.limits.maxToolCallsPerQuestion} tool calls
                </dd>
              </>
            )}
          </dl>
        )}
        {local && llm?.ready && <p className="status-pop-note">Questions and data stay on this PC.</p>}
        {tone === "bad" && local && <p className="status-pop-note">Start LM Studio, load the model (16k+ context), then wait a few seconds — this chip refreshes every 10 s.</p>}
      </Popover>
    </div>
  );
}
