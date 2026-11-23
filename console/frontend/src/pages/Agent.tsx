import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { ChatPanel, type ChatSessions } from "../components/ChatPanel";
import { rememberChat } from "../components/ChatWidget";
import { Button, cx } from "../components/ui";
import { useApp } from "../context";
import { fmtRelative } from "../lib/format";

export default function AgentPage() {
  const { toast } = useApp();
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const list = useApi<ChatSessions>("/agent/sessions");
  const { reload } = list;

  // The Ask Gemini drawer on other pages carries on with the chat open here.
  useEffect(() => { if (sessionId) rememberChat(sessionId); }, [sessionId]);
  const onSession = useCallback((id: string | null) => navigate(id ? `/agent/${id}` : "/agent", { replace: true }), [navigate]);

  const remove = async (id: string) => {
    if (!window.confirm("Delete this chat?")) return;
    try {
      await apiSend("delete", `/agent/sessions/${id}`);
      if (id === sessionId) { rememberChat(null); navigate("/agent", { replace: true }); }
      reload();
    } catch (err) {
      toast((err as ApiError).message, "error");
    }
  };

  return (
    <div className="grid h-[calc(100dvh-5.5rem)] grid-cols-1 gap-5 lg:grid-cols-[15rem_1fr]">
      <aside className="scroll-thin hidden overflow-y-auto lg:block" aria-label="Your chats">
        <Button variant="secondary" icon={<Plus className="size-4" />} className="mb-3 w-full" onClick={() => navigate("/agent")}>New chat</Button>
        <ul className="space-y-0.5">
          {(list.data?.sessions ?? []).map((s) => (
            <li key={s.session_id} className="group flex items-center">
              <button type="button" onClick={() => navigate(`/agent/${s.session_id}`)} aria-current={s.session_id === sessionId}
                className={cx("min-w-0 flex-1 rounded-full px-3 py-1.5 text-left text-sm", s.session_id === sessionId ? "bg-blue-100 text-blue-800 dark:bg-blue-200/15 dark:text-blue-200" : "text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800")}>
                <span className="block truncate">{s.title}</span>
                <span className="block text-xs text-zinc-500">{s.pending ? "waiting for your answer" : fmtRelative(s.updated_at)}</span>
              </button>
              <button type="button" onClick={() => remove(s.session_id)} aria-label={`Delete ${s.title}`} className="rounded-full p-1.5 text-zinc-400 opacity-0 hover:text-rose-500 focus:opacity-100 group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col" aria-label="Chat with the agent">
        <div className="mb-3 flex items-center gap-2 lg:hidden">
          <select aria-label="Your chats" value={sessionId ?? ""} onChange={(e) => navigate(e.target.value ? `/agent/${e.target.value}` : "/agent")}
            className="min-w-0 flex-1 rounded-full border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700">
            <option value="">New chat</option>{(list.data?.sessions ?? []).map((s) => <option key={s.session_id} value={s.session_id}>{s.title}</option>)}
          </select>
          {sessionId && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => navigate("/agent")}>New</Button>}
        </div>
        <ChatPanel sessionId={sessionId ?? null} onSession={onSession} info={list.data} onChanged={reload} autoFocus />
      </section>
    </div>
  );
}
