import { useEffect, useMemo, useRef } from "react";
import { ArrowUpRight, Compass, Database, GitCompareArrows, Lightbulb, MessageSquarePlus, Send, Sparkles, X } from "lucide-react";
import { plural } from "../format";
import { useHub } from "../stores/hub";
import { useChat, type ModelChat } from "../stores/chat";
import { useEscapeLayer } from "./Modal";
import type { DashboardSpec, FilterValue, HubModel } from "../types";
import { cx } from "../util";
import { AnswerCard } from "./AnswerCard";

const pluralize = (w: string) => (/[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : /s$/i.test(w) ? w : `${w}s`);
const lower = (s: string) => (s && s[0] === s[0].toUpperCase() && s.slice(1) !== s.slice(1).toUpperCase() ? s[0].toLowerCase() + s.slice(1) : s);

type Group = { label: string; icon: React.ReactNode; items: string[] };

/** P6: starter questions in three groups, built from the dashboard's own tiles and the active filters. */
export function suggestionGroups(spec: DashboardSpec | null, filtersText: string): Group[] {
  const tiles = spec?.tiles ?? [];
  const kpis = tiles.filter((t) => t.kind === "kpi").map((t) => t.title);
  const dims: { measure: string; dim: string }[] = [];
  let timeGrain: string | null = null;
  for (const t of tiles) {
    const m = /^(.+?)\s+by\s+(.+)$/i.exec(t.title);
    if (!m || t.kind === "kpi") continue;
    const dim = m[2].trim();
    if (/date|month|year|week|day|quarter|time/i.test(dim)) timeGrain ??= dim.toLowerCase();
    else dims.push({ measure: m[1].replace(/\s+vs\s+.*$/i, "").trim(), dim: dim.replace(/\s+vs\s+.*$/i, "") });
  }
  const k0 = kpis[0] ?? dims[0]?.measure;
  const explore = [
    dims[0] && `Top 5 ${lower(pluralize(dims[0].dim))} by ${dims[0].measure}`,
    k0 && `How did ${k0} change by ${timeGrain ?? "year"}?`,
    dims[1] && `Show ${dims[1].measure} by ${lower(dims[1].dim)} as a table`,
  ];
  const compare = [
    k0 && `Compare ${k0} this year with last year`,
    dims[0] && `Which ${lower(dims[0].dim)} grew fastest?`,
    dims[1] && `${dims[1].dim}: best vs worst by ${dims[1].measure}`,
  ];
  const explain = [
    kpis[1] && `What drives ${kpis[1]}?`,
    k0 && `Why did ${k0} change?`,
    filtersText && k0 ? `What stands out in ${k0} for ${filtersText}?` : "What can I ask about this model?",
  ];
  const clean = (xs: (string | false | undefined | null)[]) => Array.from(new Set(xs.filter((x): x is string => !!x))).slice(0, 2);
  return [
    { label: "Explore", icon: <Compass size={14} aria-hidden />, items: clean(explore) },
    { label: "Compare", icon: <GitCompareArrows size={14} aria-hidden />, items: clean(compare) },
    { label: "Explain", icon: <Lightbulb size={14} aria-hidden />, items: clean(explain) },
  ].filter((g) => g.items.length);
}

function followUps(question: string, spec: DashboardSpec | null): string[] {
  const out: string[] = [];
  for (const f of spec?.filters ?? []) {
    if (out.length >= 2) break;
    if (!question.toLowerCase().includes(f.label.toLowerCase())) out.push(`Break this down by ${f.label}`);
  }
  out.push("Compare with the previous year");
  if (out.length < 3) out.push("Show the top 10 instead");
  return out.slice(0, 3);
}

const EMPTY_CHAT: ModelChat = { conversationId: null, messages: [], draft: "", running: false };

export function ChatPanel({
  modelId,
  model,
  spec,
  filters,
  filtersText,
  offline,
  drawer,
  onClose,
  onPinned,
}: {
  modelId: string;
  model: HubModel;
  spec: DashboardSpec | null;
  filters: FilterValue[];
  filtersText: string;
  offline: boolean;
  drawer: boolean;
  onClose: () => void;
  onPinned: (spec: DashboardSpec) => void;
}) {
  const chat = useChat((s) => s.chats[modelId]) ?? EMPTY_CHAT;
  const focusNonce = useChat((s) => s.focusNonce);
  const { setDraft, send, stop, newChat, markPinned } = useChat.getState();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  useEscapeLayer(drawer, onClose);

  const modelName = model.name;
  const local = useHub((s) => s.status?.llm.provider === "local");
  const groups = useMemo(() => suggestionGroups(spec, filtersText), [spec, filtersText]);
  const last = chat.messages[chat.messages.length - 1];
  const chips = last?.role === "assistant" && last.status === "done" && !chat.running ? followUps(last.question, spec) : null;

  useEffect(() => {
    if (focusNonce) {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [focusNonce]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const ask = (q: string) => {
    if (!q.trim() || chat.running || offline) return;
    stick.current = true;
    send(modelId, q, { filters, filtersText, modelName });
  };

  return (
    <>
      {drawer && <div className="drawer-backdrop" onClick={onClose} aria-hidden />}
      <aside className={cx("chat", drawer && "is-drawer")} aria-label="Ask AI about this model">
        <header className="chat-head">
          <Sparkles size={16} aria-hidden className="accent-text" />
          <h2 className="chat-title">Ask AI</h2>
          <div className="grow" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => newChat(modelId)} disabled={!chat.messages.length && !chat.conversationId}>
            <MessageSquarePlus size={14} aria-hidden /> New chat
          </button>
          <button type="button" className="icon-btn" aria-label="Close the AI panel" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>

        <div
          className="chat-log"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {chat.messages.length === 0 && (
            <div className="chat-intro">
              <div className="chat-model">
                <div className="chat-model-icon" aria-hidden>
                  <Database size={18} />
                </div>
                <div className="chat-model-text">
                  <div className="chat-model-name">{modelName}</div>
                  <div className="small muted">
                    {model.counts ? `${plural(model.counts.tables, "table")} · ${plural(model.counts.measures, "measure")}` : "Schema not read yet"}
                    {local ? " · runs on this PC" : ""}
                  </div>
                </div>
              </div>
              <p className="small muted">
                Ask in plain language. Answers come from read-only DAX queries
                {filtersText ? (
                  <>
                    {" "}
                    and respect the dashboard filters (<span className="accent-text">{filtersText}</span>)
                  </>
                ) : null}
                .
              </p>
              {groups.map((g) => (
                <div key={g.label} className="sugg-group" role="group" aria-label={`${g.label} questions`}>
                  <div className="sugg-label">
                    {g.icon}
                    {g.label}
                  </div>
                  {g.items.map((q) => (
                    <button key={q} type="button" className="sugg-btn" onClick={() => ask(q)} disabled={offline}>
                      <span>{q}</span>
                      <ArrowUpRight size={13} aria-hidden className="sugg-go" />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {chat.messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="msg-user">
                {m.text}
              </div>
            ) : (
              <AnswerCard
                key={m.id}
                msg={m}
                modelId={modelId}
                conversationId={chat.conversationId}
                canPin={!!spec}
                onStop={() => stop(modelId)}
                onPinned={(s, title) => {
                  markPinned(modelId, m.id, title);
                  onPinned(s);
                }}
              />
            ),
          )}
          {chips && (
            <div className="chips-row followups" aria-label="Follow-up questions">
              {chips.map((q) => (
                <button key={q} type="button" className="chip-btn" onClick={() => ask(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            ask(chat.draft);
          }}
        >
          {filtersText && <div className="composer-ctx small muted">Filters: {filtersText}</div>}
          <div className="composer-box">
            <label htmlFor={`composer-${modelId}`} className="sr-only">
              Your question
            </label>
            <textarea
              id={`composer-${modelId}`}
              ref={inputRef}
              className="composer-input"
              rows={2}
              placeholder={offline ? "The model is offline — open it in Power BI Desktop to ask questions." : "Ask about this model…"}
              value={chat.draft}
              disabled={offline}
              onChange={(e) => setDraft(modelId, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(chat.draft);
                }
              }}
            />
            <button type="submit" className="btn btn-primary composer-send" disabled={chat.running || !chat.draft.trim() || offline} aria-label="Send question">
              <Send size={15} aria-hidden />
            </button>
          </div>
          <div className="composer-note small muted">Enter to send · Shift+Enter for a new line</div>
        </form>
      </aside>
    </>
  );
}
