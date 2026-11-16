import { create } from "zustand";
import { Api, SsePaths, describeError, isAbort, sse } from "../api";
import { plural } from "../format";
import { normalizeColumns } from "../heuristics";
import type { ChatEvent, FilterValue, QueryColumn } from "../types";

export type StepStatus = "active" | "done" | "failed" | "stopped";
export type Step = { id: string; kind: string; label: string; status: StepStatus; startedAt: number; endedAt?: number };

export type ToolCall = {
  toolId: string;
  tool: string;
  dax?: string;
  ok?: boolean;
  rejected?: boolean;
  error?: string;
  rows?: number;
  truncated?: boolean;
  durationMs?: number;
};

export type AnswerData = { toolId: string; dax: string; columns: QueryColumn[]; rows: unknown[][]; truncated: boolean };

export type UserMessage = { role: "user"; id: string; text: string };
export type AssistantMessage = {
  role: "assistant";
  id: string;
  question: string;
  status: "running" | "done" | "stopped" | "error";
  steps: Step[];
  text: string;
  thinking: string;
  tools: ToolCall[];
  notices: string[];
  error?: string;
  hint?: string;
  answer?: AnswerData;
  startedAt: number;
  endedAt?: number;
  lastEventAt: number;
  usage?: { provider: string; model: string; inputTokens: number; outputTokens: number; toolCalls: number };
  filtersText: string;
  modelName: string;
  pinnedTitle?: string;
};
export type Message = UserMessage | AssistantMessage;

export type ModelChat = { conversationId: string | null; messages: Message[]; draft: string; running: boolean };

type ChatState = {
  chats: Record<string, ModelChat>;
  focusNonce: number;
  setDraft: (modelId: string, draft: string, focus?: boolean) => void;
  send: (modelId: string, question: string, ctx: { filters: FilterValue[]; filtersText: string; modelName: string }) => Promise<void>;
  stop: (modelId: string) => void;
  newChat: (modelId: string) => Promise<void>;
  markPinned: (modelId: string, msgId: string, title: string) => void;
};

const blank = (): ModelChat => ({ conversationId: null, messages: [], draft: "", running: false });
const aborts = new Map<string, AbortController>();
let seq = 0;
const nid = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`;

const TOOL_LABEL: Record<string, string> = {
  run_dax: "Running query",
  get_schema: "Reading the model schema",
  list_models: "Looking up the model",
};

export const useChat = create<ChatState>((set, get) => {
  const chatOf = (modelId: string) => get().chats[modelId] ?? blank();
  const patchChat = (modelId: string, fn: (c: ModelChat) => Partial<ModelChat>) =>
    set((s) => {
      const c = s.chats[modelId] ?? blank();
      return { chats: { ...s.chats, [modelId]: { ...c, ...fn(c) } } };
    });
  const patchMsg = (modelId: string, id: string, fn: (m: AssistantMessage) => Partial<AssistantMessage>) =>
    patchChat(modelId, (c) => ({
      messages: c.messages.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...fn(m), lastEventAt: Date.now() } : m)),
    }));

  /** Close every active step, then open a new one (unless one of that kind is already active). */
  const advance = (steps: Step[], kind: string, label: string, id = `${kind}-${steps.length}`): Step[] => {
    if (steps.some((s) => s.kind === kind && s.status === "active")) return steps;
    const now = Date.now();
    return [...steps.map((s) => (s.status === "active" ? { ...s, status: "done" as const, endedAt: now } : s)), { id, kind, label, status: "active", startedAt: now }];
  };
  const closeAll = (steps: Step[], status: StepStatus): Step[] => {
    const now = Date.now();
    return steps.map((s) => (s.status === "active" ? { ...s, status, endedAt: now } : s));
  };

  function handle(modelId: string, id: string, ev: ChatEvent) {
    switch (ev.type) {
      case "session":
        patchChat(modelId, () => ({ conversationId: ev.conversationId }));
        break;
      case "stage":
        patchMsg(modelId, id, (m) => {
          if (ev.stage === "understanding") return { steps: m.steps.some((s) => s.kind === "understanding") ? m.steps : advance(m.steps, "understanding", "Understanding the question") };
          if (ev.stage === "running") {
            if (ev.toolId && m.steps.some((s) => s.id === ev.toolId)) return {};
            return { steps: advance(m.steps, "query", ev.text || "Running query", ev.toolId ?? `q-${m.steps.length}`) };
          }
          if (ev.stage === "reading") return { steps: advance(m.steps, "reading", "Reading the results") };
          if (ev.stage === "answering") return { steps: advance(m.steps, "answering", "Writing the answer") };
          return { steps: advance(m.steps, String(ev.stage), ev.text || String(ev.stage)) };
        });
        break;
      case "thinking":
        patchMsg(modelId, id, (m) => ({ thinking: (m.thinking + ev.text).slice(-600) }));
        break;
      case "tool":
        patchMsg(modelId, id, (m) => {
          const tools = [...m.tools.filter((t) => t.toolId !== ev.toolId), { toolId: ev.toolId, tool: ev.tool, dax: ev.dax }];
          const label = TOOL_LABEL[ev.tool] ?? `Using ${ev.tool.replace(/_/g, " ")}`;
          const exists = m.steps.some((s) => s.id === ev.toolId);
          // A "running" stage that arrived without a toolId is adopted by the first tool call.
          const orphan = m.steps.find((s) => s.kind === "query" && s.status === "active" && s.id.startsWith("q-"));
          const steps = exists
            ? m.steps
            : orphan
              ? m.steps.map((s) => (s === orphan ? { ...s, id: ev.toolId, label } : s))
              : advance(m.steps, `tool:${ev.toolId}`, label, ev.toolId);
          return { tools, steps };
        });
        break;
      case "tool_result":
        patchMsg(modelId, id, (m) => {
          const tool = m.tools.find((t) => t.toolId === ev.toolId);
          const isQuery = !tool || tool.tool === "run_dax";
          const tools = m.tools.map((t) =>
            t.toolId === ev.toolId
              ? { ...t, ok: ev.ok, rejected: ev.rejected, error: ev.error, rows: ev.rows, truncated: ev.truncated, durationMs: ev.durationMs }
              : t,
          );
          const label = ev.ok
            ? isQuery
              ? `Running query · ${plural(ev.rows ?? 0, "row")}${ev.truncated ? " (capped)" : ""}${ev.durationMs != null ? ` · ${ev.durationMs} ms` : ""}`
              : tool?.tool === "get_schema"
                ? "Read the model schema"
                : "Done"
            : ev.rejected
              ? "Query blocked by the safety gate — retrying"
              : "Query failed — retrying";
          const now = Date.now();
          let steps = m.steps.map((s) => (s.id === ev.toolId ? { ...s, label, status: (ev.ok ? "done" : "failed") as StepStatus, endedAt: now } : s));
          // Keep something visibly moving while the model reads the result.
          if (!steps.some((s) => s.status === "active")) steps = advance(steps, ev.ok ? "reading" : "thinking", ev.ok ? "Reading the results" : "Rethinking the query");
          return { tools, steps };
        });
        break;
      case "text":
        patchMsg(modelId, id, (m) => ({ text: m.text + ev.text, steps: advance(m.steps, "answering", "Writing the answer") }));
        break;
      case "notice":
        patchMsg(modelId, id, (m) => ({ notices: [...m.notices, ev.text] }));
        break;
      case "answer_data": {
        const rows = ev.rows ?? [];
        patchMsg(modelId, id, () => ({ answer: { toolId: ev.toolId, dax: ev.dax, columns: normalizeColumns(ev.columns, rows), rows, truncated: !!ev.truncated } }));
        break;
      }
      case "done":
        patchMsg(modelId, id, (m) => ({ status: "done", steps: closeAll(m.steps, "done"), usage: ev.usage, endedAt: Date.now() }));
        break;
      case "error":
        patchMsg(modelId, id, (m) => ({ status: "error", error: ev.error, steps: closeAll(m.steps, "failed"), endedAt: Date.now() }));
        break;
    }
  }

  return {
    chats: {},
    focusNonce: 0,

    setDraft: (modelId, draft, focus) => {
      patchChat(modelId, () => ({ draft }));
      if (focus) set((s) => ({ focusNonce: s.focusNonce + 1 }));
    },

    send: async (modelId, question, ctx) => {
      const q = question.trim();
      if (!q || chatOf(modelId).running) return;
      const id = nid();
      const now = Date.now();
      const msg: AssistantMessage = {
        role: "assistant",
        id,
        question: q,
        status: "running",
        steps: [{ id: "understanding", kind: "understanding", label: "Understanding the question", status: "active", startedAt: now }],
        text: "",
        thinking: "",
        tools: [],
        notices: [],
        startedAt: now,
        lastEventAt: now,
        filtersText: ctx.filtersText,
        modelName: ctx.modelName,
      };
      patchChat(modelId, (c) => ({ messages: [...c.messages, { role: "user", id: nid(), text: q }, msg], draft: "", running: true }));

      const ctl = new AbortController();
      aborts.set(modelId, ctl);
      try {
        await sse<ChatEvent>(
          SsePaths.chat,
          { modelId, question: q, conversationId: chatOf(modelId).conversationId ?? undefined, filters: ctx.filters },
          (ev) => handle(modelId, id, ev),
          ctl.signal,
        );
        patchMsg(modelId, id, (m) => (m.status === "running" ? { status: "done", steps: closeAll(m.steps, "done"), endedAt: Date.now() } : {}));
      } catch (e) {
        if (isAbort(e)) {
          patchMsg(modelId, id, (m) => ({ status: "stopped", steps: closeAll(m.steps, "stopped"), endedAt: Date.now() }));
        } else {
          const d = describeError(e);
          patchMsg(modelId, id, (m) => ({ status: "error", error: d.message, hint: d.hint, steps: closeAll(m.steps, "failed"), endedAt: Date.now() }));
        }
      } finally {
        if (aborts.get(modelId) === ctl) aborts.delete(modelId);
        patchChat(modelId, () => ({ running: false }));
      }
    },

    stop: (modelId) => aborts.get(modelId)?.abort(),

    newChat: async (modelId) => {
      get().stop(modelId);
      const cid = chatOf(modelId).conversationId;
      patchChat(modelId, () => ({ conversationId: null, messages: [], running: false }));
      if (cid) await Api.forgetChat(cid).catch(() => undefined);
    },

    markPinned: (modelId, msgId, title) => patchMsg(modelId, msgId, () => ({ pinnedTitle: title })),
  };
});
