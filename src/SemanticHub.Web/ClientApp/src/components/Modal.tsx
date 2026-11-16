import { ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "../util";

// Stack so Escape only closes the topmost layer (dialog or popover).
const layers: symbol[] = [];
export function useEscapeLayer(open: boolean, onEscape: () => void) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const me = Symbol("layer");
    layers.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && layers[layers.length - 1] === me) {
        e.stopPropagation();
        cb.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = layers.indexOf(me);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [open]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  variant?: "center" | "sheet";
  subtitle?: ReactNode;
  initialFocus?: string;
};

export function Modal({ open, onClose, title, subtitle, children, footer, size = "md", variant = "center", initialFocus }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEscapeLayer(open, onClose);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const root = ref.current;
      if (!root) return;
      const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || root.querySelector<HTMLElement>("[data-autofocus]") || root;
      target.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [open, initialFocus]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className={cx("modal-backdrop", variant === "sheet" && "is-sheet")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx("modal", `modal-${size}`, variant === "sheet" && "modal-sheet")} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="modal-head">
          <div className="modal-titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="modal-sub">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button type="button" className={cx("btn", danger ? "btn-danger" : "btn-primary")} onClick={onConfirm} disabled={busy}>
            {busy && <span className="spinner" aria-hidden />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{body}</div>
    </Modal>
  );
}
