import { ReactNode, useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { useEscapeLayer } from "./Modal";
import { cx } from "../util";

/** Anchored popover: render inside a `position: relative` wrapper next to its trigger. Closes on outside click and Escape. */
export function Popover({
  open,
  onClose,
  children,
  align = "start",
  className,
  role = "dialog",
  label,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  role?: string;
  label?: string;
  triggerRef?: React.RefObject<HTMLElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, () => {
    onClose();
    triggerRef?.current?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || triggerRef?.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose, triggerRef]);
  if (!open) return null;
  return (
    <div ref={ref} className={cx("popover", `popover-${align}`, className)} role={role} aria-label={label}>
      {children}
    </div>
  );
}

export type MenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  /** Leave the menu open after selecting (Arrange steps, submenu navigation). */
  keepOpen?: boolean;
  /** Opens a nested list; shows a chevron and also opens with ArrowRight. */
  submenu?: boolean;
  /** Draw a separator above this item. */
  divider?: boolean;
};

/** A menu button's list with arrow-key navigation (role="menu"). */
export function MenuList({ items, onClose, label }: { items: MenuItem[]; onClose: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
  }, []);
  const visible = items.filter((it) => !it.hidden);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      els[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      els[els.length - 1]?.focus();
    } else if (e.key === "ArrowRight") {
      const it = visible.find((x) => x.label === (document.activeElement as HTMLElement)?.dataset.label);
      if (it?.submenu && !it.disabled) {
        e.preventDefault();
        it.onSelect();
      }
    } else if (e.key === "ArrowLeft") {
      const back = visible.find((x) => x.label === "Back");
      if (back) {
        e.preventDefault();
        back.onSelect();
      }
    } else if (e.key === "Tab") {
      onClose();
    }
  };
  return (
    <div ref={ref} className="menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {visible.map((it) => (
        <div key={it.label} className={cx(it.divider && "menu-divided")} role="none">
          <button
            type="button"
            role="menuitem"
            data-label={it.label}
            aria-haspopup={it.submenu ? "menu" : undefined}
            className={cx("menu-item", it.danger && "is-danger")}
            disabled={it.disabled}
            onClick={() => {
              if (!it.keepOpen) onClose();
              it.onSelect();
            }}
          >
            {it.icon}
            <span className="grow">{it.label}</span>
            {it.submenu && <ChevronRight size={14} aria-hidden className="menu-chev" />}
          </button>
        </div>
      ))}
    </div>
  );
}
