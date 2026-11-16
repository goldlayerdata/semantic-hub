import { NavLink } from "react-router-dom";
import { Database, LayoutGrid, PanelLeftClose, PanelLeftOpen, ScrollText } from "lucide-react";
import { useHub } from "../stores/hub";
import { useUi } from "../stores/ui";
import { cx } from "../util";

export function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden className="logo">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <rect x="8" y="17" width="4" height="7" rx="1.5" fill="var(--accent-contrast)" />
      <rect x="14" y="12" width="4" height="12" rx="1.5" fill="var(--accent-contrast)" />
      <rect x="20" y="8" width="4" height="16" rx="1.5" fill="var(--accent-contrast)" />
    </svg>
  );
}

export function Sidebar() {
  const { sidebarCollapsed: collapsed, toggleSidebar } = useUi();
  const models = useHub((s) => s.models);
  const loaded = useHub((s) => s.modelsLoaded);

  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar-brand">
        <Logo />
        {!collapsed && (
          <div className="brand-text">
            <span className="brand-name">Semantic Hub</span>
            <span className="brand-sub">BI + AI analyst</span>
          </div>
        )}
      </div>

      <nav className="sidebar-nav">
        <NavLink to="/" end className={({ isActive }) => cx("nav-item", isActive && "is-active")} title={collapsed ? "Hub" : undefined}>
          <LayoutGrid size={18} aria-hidden />
          <span className="nav-label">Hub</span>
        </NavLink>
        <NavLink to="/audit" className={({ isActive }) => cx("nav-item", isActive && "is-active")} title={collapsed ? "Audit" : undefined}>
          <ScrollText size={18} aria-hidden />
          <span className="nav-label">Audit</span>
        </NavLink>
      </nav>

      <div className="sidebar-section">
        {!collapsed && <div className="sidebar-heading">Models</div>}
        <ul className="model-list">
          {!loaded && !collapsed && <li className="sidebar-muted">Loading…</li>}
          {loaded && models.length === 0 && !collapsed && <li className="sidebar-muted">No models yet</li>}
          {models.map((m) => (
            <li key={m.id}>
              <NavLink
                to={`/models/${encodeURIComponent(m.id)}`}
                className={({ isActive }) => cx("nav-item model-item", isActive && "is-active")}
                title={collapsed ? `${m.name} (${m.online ? "online" : "offline"})` : m.sourcePath}
              >
                <span className="model-icon">
                  <Database size={16} aria-hidden />
                  <span className={cx("dot", m.online ? "dot-good" : "dot-off")} aria-hidden />
                </span>
                <span className="nav-label">{m.name}</span>
                <span className="sr-only">{m.online ? " (online)" : " (offline)"}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      <button type="button" className="nav-item sidebar-toggle" onClick={toggleSidebar} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}>
        {collapsed ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
        <span className="nav-label">Collapse</span>
      </button>
    </aside>
  );
}
