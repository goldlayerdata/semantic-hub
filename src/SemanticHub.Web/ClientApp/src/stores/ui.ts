import { useEffect, useState } from "react";
import { create } from "zustand";

// ---- theme ----

export type ThemeMode = "light" | "dark" | "system";
type Resolved = "light" | "dark";
const KEY = "sh-theme";

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage blocked */
  }
  return "system";
}

const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function resolve(mode: ThemeMode): Resolved {
  if (mode === "system") return media?.matches ? "dark" : "light";
  return mode;
}

function apply(resolved: Resolved) {
  document.documentElement.setAttribute("data-theme", resolved);
}

type ThemeState = { mode: ThemeMode; resolved: Resolved; setMode: (m: ThemeMode) => void };

export const useTheme = create<ThemeState>((set) => {
  const mode = readMode();
  const resolved = resolve(mode);
  apply(resolved);
  media?.addEventListener("change", () => {
    const s = useTheme.getState();
    if (s.mode !== "system") return;
    const r = resolve("system");
    apply(r);
    set({ resolved: r });
  });
  return {
    mode,
    resolved,
    setMode: (m) => {
      try {
        localStorage.setItem(KEY, m);
      } catch {
        /* storage blocked: theme still applies for this session */
      }
      const r = resolve(m);
      apply(r);
      set({ mode: m, resolved: r });
    },
  };
});

// ---- layout & page chrome ----

// v3: the dashboard canvas needs ≥ 900 px to stay arrangeable (D7), so the chat docks only on wide screens
// (≥ 1600 px; below it opens as a drawer) and the sidebar starts collapsed below 1280 px.
export const CHAT_DOCK_MIN = 1600;
const narrow = () => typeof window !== "undefined" && window.innerWidth < 1280;
const wide = () => typeof window !== "undefined" && window.innerWidth >= CHAT_DOCK_MIN;

export type Crumb = { label: string; to: string };

type UiState = {
  sidebarCollapsed: boolean;
  chatOpen: boolean;
  pageTitle: string;
  crumb: Crumb | null;
  toggleSidebar: () => void;
  setChatOpen: (open: boolean) => void;
  setPageTitle: (t: string, crumb?: Crumb | null) => void;
};

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: narrow(),
  chatOpen: wide(),
  pageTitle: "",
  crumb: null,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setPageTitle: (pageTitle, crumb = null) => {
    document.title = pageTitle ? `${pageTitle} · Semantic Hub` : "Semantic Hub";
    set({ pageTitle, crumb });
  },
}));

// ---- toasts ----

export type Toast = { id: number; text: string; tone?: "info" | "error" | "good"; action?: { label: string; run: () => void }; key?: string };
type ToastState = { toasts: Toast[]; push: (t: Omit<Toast, "id">, ms?: number) => void; dismiss: (id: number) => void };
let toastId = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ms = 5000) => {
    const id = ++toastId;
    // A keyed toast (e.g. "layout") replaces the previous one instead of stacking.
    const rest = t.key ? get().toasts.filter((x) => x.key !== t.key) : get().toasts;
    set({ toasts: [...rest.slice(-3), { ...t, id }] });
    window.setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (text: string, tone: Toast["tone"] = "info", action?: Toast["action"], key?: string) =>
  useToasts.getState().push({ text, tone, action, key }, action ? 8000 : 4000);

/** Hook that tracks a media query (used for the chat drawer breakpoint). */
export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}
