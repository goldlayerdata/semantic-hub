import { ReactNode } from "react";
import { AlertTriangle, Info, RotateCcw, X } from "lucide-react";
import { useToasts } from "../stores/ui";
import { cx } from "../util";

/** Readable error with a next step. Never shows raw JSON. */
export function ErrorBox({ message, hint, onRetry, retryLabel = "Try again", compact }: { message: string; hint?: string; onRetry?: () => void; retryLabel?: string; compact?: boolean }) {
  return (
    <div className={cx("errorbox", compact && "is-compact")} role="alert">
      <AlertTriangle size={compact ? 14 : 16} aria-hidden className="errorbox-icon" />
      <div className="errorbox-text">
        <div className="errorbox-msg">{message}</div>
        {hint && <div className="errorbox-hint">{hint}</div>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <RotateCcw size={13} aria-hidden />
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function Banner({ tone = "warn", children, action }: { tone?: "warn" | "info" | "bad"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("banner", `banner-${tone}`)} role={tone === "info" ? "status" : "alert"}>
      {tone === "info" ? <Info size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}
      <div className="banner-text">{children}</div>
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role={label ? "status" : undefined}>
      <span className="spinner" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {children && <div className="empty-text">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={cx("toast", t.tone && `toast-${t.tone}`)} role={t.tone === "error" ? "alert" : "status"}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cx("segmented", size === "sm" && "is-sm")} role="radiogroup" aria-label={label}>
      {options.map((o, idx) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          aria-label={o.title}
          className={cx("seg", value === o.value && "is-on")}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              const n = options[(i + 1) % options.length];
              onChange(n.value);
              (e.currentTarget.parentElement?.children[(i + 1) % options.length] as HTMLElement)?.focus();
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              const j = (i - 1 + options.length) % options.length;
              onChange(options[j].value);
              (e.currentTarget.parentElement?.children[j] as HTMLElement)?.focus();
            }
          }}
          tabIndex={value === o.value || (idx === 0 && !options.some((x) => x.value === value)) ? 0 : -1}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
