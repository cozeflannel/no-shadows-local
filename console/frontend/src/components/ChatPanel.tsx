import { ArrowUp, Check, ChevronDown, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiGet, apiSend, type ApiError } from "../api/client";
import { useApp } from "../context";
import { Badge, Button, cx, ErrorState, OffNotice } from "./ui";

export interface ChatMessage { role: "user" | "assistant" | "tool"; text: string; ts: string; tool: string | null; args: Record<string, unknown> | null; status: string | null; result: unknown; citations: string[] }
export interface ChatSession { session_id: string; title: string; messages: ChatMessage[]; pending: { tool: string; args: Record<string, unknown>; summary: string } | null }
export interface ChatSessions {
  sessions: { session_id: string; title: string; updated_at: string | null; messages: number; pending: boolean }[];
  tools: { name: string; description: string; changes_something: boolean }[];
  can_act: boolean; actions_switch: boolean;
}

const STARTERS = ["What needs me right now?", "Summarise the alerts held for review", "Who is on shift, and is coverage enough for the next hours?", "Run a temp check on the most engaged alert today"];
const STATUS_WORDS: Record<string, string> = { error: "failed", denied: "not allowed", pending: "waiting for you", cancelled: "cancelled", ok: "done", done: "done" };

function ToolLine({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const tone = m.status === "error" || m.status === "denied" ? "rose" : m.status === "pending" ? "violet" : m.status === "cancelled" ? "zinc" : "emerald";
  return (
    <div className="text-xs text-zinc-500">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800">
        <Wrench className="size-3" aria-hidden />Used: {(m.tool ?? "a tool").replace(/_/g, " ")}<Badge tone={tone}>{STATUS_WORDS[m.status ?? "done"] ?? m.status}</Badge>
        <ChevronDown className={cx("size-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && <pre className="scroll-thin mt-2 max-h-64 overflow-auto rounded-xl bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">{JSON.stringify({ asked: m.args, answer: m.result ?? m.text }, null, 2)}</pre>}
    </div>
  );
}

/**
 * The Console chat agent: the conversation, Gemini's answers and the tools it used, a confirmation when a tool would
 * change something, and the box to type in. Used by the Chat agent page and by the Ask Gemini drawer on every page.
 * `sessionId` null = a new chat; the first message starts one and reports its id through `onSession`.
 */
export function ChatPanel({ sessionId, onSession, info, onChanged, compact = false, autoFocus = false, forgetMissing = false }: {
  sessionId: string | null; onSession: (id: string | null) => void; info?: ChatSessions | null; onChanged?: () => void;
  compact?: boolean; autoFocus?: boolean; forgetMissing?: boolean;
}) {
  const { me } = useApp();
  const [session, setSession] = useState<ChatSession | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!sessionId) { loaded.current = null; setSession(null); return; }
    if (loaded.current === sessionId) return; // this chat was just started here: its first turn is already on screen
    loaded.current = sessionId;
    let stale = false;
    apiGet<ChatSession>(`/agent/sessions/${sessionId}`).then((s) => { if (!stale) setSession(s); }).catch((e: ApiError) => {
      if (stale) return;
      if (forgetMissing && e.status === 404) { loaded.current = null; onSession(null); return; } // a chat deleted elsewhere: start a new one
      setError(e);
    });
    return () => { stale = true; };
  }, [sessionId, forgetMissing, onSession]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [session?.messages.length, busy]);
  useEffect(() => { if (autoFocus) window.setTimeout(() => box.current?.focus(), 50); }, [autoFocus, sessionId]);

  const call = useCallback(async (fn: () => Promise<ChatSession>) => {
    setBusy(true);
    setError(null);
    try {
      setSession(await fn());
      onChanged?.();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const send = async (message: string) => {
    const body = message.trim();
    if (!body || busy) return;
    setText("");
    let id = sessionId;
    if (!id) {
      try {
        id = (await apiSend<ChatSession>("post", "/agent/sessions")).session_id;
        loaded.current = id;
        onSession(id);
      } catch (err) {
        setError(err as ApiError);
        return;
      }
    }
    setSession((s) => ({ session_id: id!, title: s?.title ?? body.slice(0, 60), pending: null, messages: [...(s?.messages ?? []), { role: "user", text: body, ts: new Date().toISOString(), tool: null, args: null, status: null, result: null, citations: [] }] }));
    await call(() => apiSend<ChatSession>("post", `/agent/sessions/${id}/messages`, { text: body }));
  };

  const messages = session?.messages ?? [];
  const pending = session?.pending;
  const changers = info?.tools.filter((t) => t.changes_something).length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {info && !info.actions_switch && me?.can_act && !compact && <OffNotice what="Acting from the chat agent" flag="console_chat_agent">It can look things up and answer; it cannot change anything yet.</OffNotice>}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className={cx("mx-auto flex max-w-2xl flex-col", compact ? "pt-2" : "h-full justify-center pb-10")}>
            <h2 className={cx("text-spark w-fit font-medium leading-tight tracking-tight", compact ? "text-2xl" : "text-3xl sm:text-4xl")}>Hello{me?.name ? `, ${me.name.split(" ")[0]}` : ""}</h2>
            <p className={cx("mt-2 text-zinc-500 dark:text-zinc-400", compact ? "text-sm" : "text-xl sm:text-2xl")}>Ask about any alert, a shift or a temp check, or have it done.</p>
            <div className={cx("mt-6 grid grid-cols-1 gap-2", !compact && "sm:grid-cols-2")}>
              {STARTERS.map((s) => <button key={s} type="button" onClick={() => void send(s)} className="rounded-2xl bg-zinc-100 p-3 text-left text-sm text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800/70 dark:text-zinc-300 dark:hover:bg-zinc-800">{s}</button>)}
            </div>
          </div>
        ) : (
          <div className={cx("mx-auto space-y-5 pb-6", compact ? "max-w-full" : "max-w-3xl")}>
            {messages.map((m, i) => m.role === "user" ? (
              <div key={i} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-3xl rounded-br-md bg-zinc-200/80 px-4 py-2.5 text-sm text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{m.text}</div>
            ) : m.role === "tool" ? <ToolLine key={i} m={m} /> : (
              <div key={i} className="prose-plain text-sm text-zinc-800 dark:text-zinc-200">
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                {m.citations.length > 0 && <p className="mt-2 flex flex-wrap gap-1.5">{m.citations.map((c) => <Badge key={c} tone="zinc">{c}</Badge>)}</p>}
              </div>
            ))}
            {pending && (
              <div className="glow rounded-2xl bg-white p-4 dark:bg-zinc-900">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Should it go ahead? {pending.summary}</p>
                <details className="mt-2 text-xs text-zinc-500">
                  <summary className="cursor-pointer">What it will send</summary>
                  <pre className="scroll-thin mt-2 max-h-40 overflow-auto rounded-xl bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-950">{JSON.stringify(pending.args, null, 2)}</pre>
                </details>
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={() => call(() => apiSend<ChatSession>("post", `/agent/sessions/${session!.session_id}/confirm`, { approve: true }))}>Do it</Button>
                  <Button icon={<X className="size-4" />} disabled={busy} onClick={() => call(() => apiSend<ChatSession>("post", `/agent/sessions/${session!.session_id}/confirm`, { approve: false }))}>Cancel</Button>
                </div>
              </div>
            )}
            {busy && !pending && <p className="text-sm text-zinc-500" role="status">Working on it…</p>}
            <div ref={end} />
          </div>
        )}
      </div>
      <ErrorState error={error} />
      <form className={cx("mt-3 w-full", !compact && "mx-auto max-w-3xl")} onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <div className={cx("glow flex items-end gap-2 rounded-[28px] bg-white p-2 pl-5 dark:bg-zinc-900", busy && "glow-live")}>
          <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={1} disabled={!!pending} aria-label="Message the agent"
            placeholder={pending ? "Answer the question above first" : "Ask the agent"}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-500 dark:text-zinc-100" />
          <button type="submit" disabled={!text.trim() || busy || !!pending} aria-label="Send"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-blue-200 dark:text-blue-900 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"><ArrowUp className="size-4" /></button>
        </div>
        <p className="mt-2 text-center text-xs text-zinc-500">
          {info ? (info.can_act ? `It can look things up and act with ${info.tools.length} tools; the ${changers} that change something ask you first.` : `It can look things up with ${info.tools.length} tools; it can't change anything.`) : ""} Every question and answer is kept in the audit log.
        </p>
      </form>
    </div>
  );
}
