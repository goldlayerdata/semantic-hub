import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Outlet } from "react-router-dom";
import { useHub } from "../stores/hub";
import { useUi, type Crumb } from "../stores/ui";
import { cx, useInterval } from "../util";
import { Toasts } from "./Feedback";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

const SlotContext = createContext<HTMLElement | null>(null);

/** Pages render their top-bar actions through this portal. */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  return slot ? createPortal(children, slot) : null;
}

/** Sets the top-bar title (optionally under a breadcrumb parent) and the document title. */
export function usePageTitle(title: string, crumb?: Crumb | null) {
  const set = useUi((s) => s.setPageTitle);
  const label = crumb?.label;
  const to = crumb?.to;
  useEffect(() => set(title, label && to ? { label, to } : null), [title, label, to, set]);
}

export function AppShell() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // F1.3: status every 10 s; models too so online dots stay current.
  useInterval(() => {
    const { loadStatus, loadModels } = useHub.getState();
    loadStatus();
    loadModels();
  }, 10_000);

  return (
    <SlotContext.Provider value={slot}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className={cx("shell", collapsed && "is-collapsed")}>
        <Sidebar />
        <div className="shell-main">
          <TopBar actionsRef={setSlot} />
          <main id="main" className="shell-content" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
      <Toasts />
    </SlotContext.Provider>
  );
}
