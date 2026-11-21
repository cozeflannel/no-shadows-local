import { ArrowUp, Check, Plus, Trash2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { apiGet, apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { Badge, Button, cx, ErrorState, OffNotice } from "../components/ui";
import { useApp } from "../context";
import { fmtRelative } from "../lib/format";

interface Message { role: "user" | "assistant" | "tool"; text: string; ts: string; tool: string | null; args: Record<string, unknown> | null; status: string | null; result: unknown; citations: string[] }
interface Session { session_id: string; title: string; messages: Message[]; pending: { tool: string; args: Record<string, unknown>; summary: string } | null }
interface Sessions {
  sessions: { session_id: string; title: string; updated_at: string | null; messages: number; pending: boolean }[];
  tools: { name: string; description: string; changes_something: boolean }[];
  can_act: boolean; actions_switch: boolean;
}

const STARTERS = ["What needs me right now?", "Summarise the alerts held for review", "Who is on shift, and is coverage enough for the next hours?", "Run a temp check on the most engaged alert today"];

function ToolLine({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  const tone = m.status === "error" || m.status === "denied" ? "rose" : m.status === "pending" ? "amber" : m.status === "cancelled" ? "zinc" : "emerald";
  return (
    <div className="text-xs text-zinc-500">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800">
        <Wrench className="size-3" />{m.tool}<Badge tone={tone}>{m.status ?? "done"}</Badge>
      </button>
      {open && <pre className="scroll-thin mt-2 max-h-64 overflow-auto rounded-xl bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">{JSON.stringify({ args: m.args, result: m.result ?? m.text }, null, 2)}</pre>}
    </div>
  );
}

export default function AgentPage() {
  const { me, toast } = useApp();
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const list = useApi<Sessions>("/agent/sessions");
  const [session, setSession] = useState<Session | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const loaded = useRef<string | null>(null);
  const { reload } = list;

  useEffect(() => {
    setError(null);
    if (!sessionId) { loaded.current = null; setSession(null); return; }
    if (loaded.current === sessionId) return; // this chat was just started here: its first turn is already on screen
    loaded.current = sessionId;
    let stale = false;
    apiGet<Session>(`/agent/sessions/${sessionId}`).then((s) => { if (!stale) setSession(s); }).catch((e) => { if (!stale) setError(e as ApiError); });
    return () => { stale = true; };
  }, [sessionId]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [session?.messages.length, busy]);

  const call = useCallback(async (fn: () => Promise<Session>) => {
    setBusy(true);
    setError(null);
    try {
      setSession(await fn());
      reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const send = async (message: string) => {
    const body = message.trim();
    if (!body || busy) return;
    setText("");
    let id = sessionId;
    if (!id) {
      try {
        id = (await apiSend<Session>("post", "/agent/sessions")).session_id;
        loaded.current = id;
        navigate(`/agent/${id}`, { replace: true });
      } catch (err) {
        setError(err as ApiError);
        return;
      }
    }
    setSession((s) => ({ session_id: id!, title: s?.title ?? body.slice(0, 60), pending: null, messages: [...(s?.messages ?? []), { role: "user", text: body, ts: new Date().toISOString(), tool: null, args: null, status: null, result: null, citations: [] }] }));
    await call(() => apiSend<Session>("post", `/agent/sessions/${id}/messages`, { text: body }));
  };
  const remove = async (id: string) => {
    if (!window.confirm("Delete this chat?")) return;
    try {
      await apiSend("delete", `/agent/sessions/${id}`);
      if (id === sessionId) navigate("/agent", { replace: true });
      reload();
    } catch (err) {
      toast((err as ApiError).message, "error");
    }
  };

  const messages = session?.messages ?? [];
  const pending = session?.pending;
  return (
    <div className="grid h-[calc(100dvh-5.5rem)] grid-cols-1 gap-5 lg:grid-cols-[15rem_1fr]">
      <aside className="scroll-thin hidden overflow-y-auto lg:block">
        <Button variant="secondary" icon={<Plus className="size-4" />} className="mb-3 w-full" onClick={() => navigate("/agent")}>New chat</Button>
        <ul className="space-y-0.5">
          {(list.data?.sessions ?? []).map((s) => (
            <li key={s.session_id} className="group flex items-center">
              <button type="button" onClick={() => navigate(`/agent/${s.session_id}`)} aria-current={s.session_id === sessionId}
                className={cx("min-w-0 flex-1 rounded-full px-3 py-1.5 text-left text-sm", s.session_id === sessionId ? "bg-blue-100 text-blue-800 dark:bg-blue-200/15 dark:text-blue-200" : "text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800")}>
                <span className="block truncate">{s.title}</span>
                <span className="block text-xs text-zinc-500">{s.pending ? "waiting for you" : fmtRelative(s.updated_at)}</span>
              </button>
              <button type="button" onClick={() => remove(s.session_id)} aria-label={`Delete ${s.title}`} className="rounded-full p-1.5 text-zinc-400 opacity-0 hover:text-rose-500 focus:opacity-100 group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col">
        <div className="mb-3 flex items-center gap-2 lg:hidden">
          <select aria-label="Chats" value={sessionId ?? ""} onChange={(e) => navigate(e.target.value ? `/agent/${e.target.value}` : "/agent")}
            className="min-w-0 flex-1 rounded-full border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700">
            <option value="">New chat</option>{(list.data?.sessions ?? []).map((s) => <option key={s.session_id} value={s.session_id}>{s.title}</option>)}
          </select>
          {sessionId && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => navigate("/agent")}>New</Button>}
        </div>
        {list.data && !list.data.actions_switch && me?.can_act && <OffNotice what="Acting from the chat agent" flag="console_chat_agent">It can look things up and answer; it cannot change anything yet.</OffNotice>}
        <div className="scroll-thin flex-1 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <div className="mx-auto flex h-full max-w-2xl flex-col justify-center pb-10">
              <h1 className="text-spark w-fit text-3xl font-medium leading-tight tracking-tight sm:text-4xl">Hello{me?.name ? `, ${me.name.split(" ")[0]}` : ""}</h1>
              <p className="mt-2 text-xl text-zinc-400 sm:text-2xl dark:text-zinc-500">Ask about any alert, or have it handled.</p>
              <div className="mt-8 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => <button key={s} type="button" onClick={() => send(s)} className="rounded-2xl bg-zinc-100 p-4 text-left text-sm text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800">{s}</button>)}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5 pb-6">
              {messages.map((m, i) => m.role === "user" ? (
                <div key={i} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-3xl rounded-br-md bg-zinc-200/80 px-4 py-2.5 text-sm text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">{m.text}</div>
              ) : m.role === "tool" ? <ToolLine key={i} m={m} /> : (
                <div key={i} className="prose-plain text-zinc-800 dark:text-zinc-200">
                  <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  {m.citations.length > 0 && <p className="mt-2 flex flex-wrap gap-1.5">{m.citations.map((c) => <Badge key={c} tone="zinc">{c}</Badge>)}</p>}
                </div>
              ))}
              {pending && (
                <div className="glow rounded-2xl bg-white p-4 dark:bg-zinc-900">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Confirm: {pending.summary}</p>
                  <pre className="scroll-thin mt-2 max-h-40 overflow-auto rounded-xl bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-950">{JSON.stringify(pending.args, null, 2)}</pre>
                  <div className="mt-3 flex gap-2">
                    <Button variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={() => call(() => apiSend<Session>("post", `/agent/sessions/${session!.session_id}/confirm`, { approve: true }))}>Do it</Button>
                    <Button icon={<X className="size-4" />} disabled={busy} onClick={() => call(() => apiSend<Session>("post", `/agent/sessions/${session!.session_id}/confirm`, { approve: false }))}>Cancel</Button>
                  </div>
                </div>
              )}
              {busy && !pending && <p className="text-sm text-zinc-500">Working…</p>}
              <div ref={end} />
            </div>
          )}
        </div>
        <ErrorState error={error} />
        <form className="mx-auto mt-3 w-full max-w-3xl" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <div className={cx("glow flex items-end gap-2 rounded-[28px] bg-white p-2 pl-5 dark:bg-zinc-900", busy && "glow-live")}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} disabled={!!pending} aria-label="Message the agent"
              placeholder={pending ? "Confirm or cancel the action above first" : "Ask the agent"}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-500 dark:text-zinc-100" />
            <button type="submit" disabled={!text.trim() || busy || !!pending} aria-label="Send"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-blue-200 dark:text-blue-900 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"><ArrowUp className="size-4" /></button>
          </div>
          <p className="mt-2 text-center text-xs text-zinc-500">
            {list.data ? (list.data.can_act ? `${list.data.tools.length} tools. The ${list.data.tools.filter((t) => t.changes_something).length} that change something ask first.` : `${list.data.tools.length} tools, all read-only.`) : ""} Every turn is in the audit log.
          </p>
        </form>
      </section>
    </div>
  );
}
