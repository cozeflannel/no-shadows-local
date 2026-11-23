import { Maximize2, Plus, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

import { useApi } from "../api/hooks";
import { ChatPanel, type ChatSessions } from "./ChatPanel";
import { cx } from "./ui";

const KEY = "console-chat-session";

/** The chat the Ask Gemini drawer continues (kept for this browser tab, so it survives moving between pages and a reload). */
export function rememberChat(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode */ }
}

function recalled(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

/** The Ask Gemini button in the corner of every page, and the drawer with the Console chat agent it opens. */
export function ChatWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(recalled);
  const button = useRef<HTMLButtonElement>(null);
  const info = useApi<ChatSessions>(open ? "/agent/sessions" : null);
  const onAgentPage = location.pathname === "/agent" || location.pathname.startsWith("/agent/");

  const choose = useCallback((id: string | null) => { setSessionId(id); rememberChat(id); }, []);
  const close = useCallback(() => { setOpen(false); window.setTimeout(() => button.current?.focus(), 0); }, []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) close(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, close]);
  useEffect(() => { if (onAgentPage) setOpen(false); else setSessionId(recalled()); }, [onAgentPage]); // the page may have moved to another chat

  if (onAgentPage) return null;
  return (
    <>
      {!open && (
        <button ref={button} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Ask Gemini"
          className="bg-spark fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full p-3 text-sm font-medium text-white shadow-lg ring-1 ring-white/20 transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 sm:bottom-5 sm:right-5 sm:px-4 sm:py-2.5">
          <Sparkles className="size-5 sm:size-4" aria-hidden /><span className="hidden sm:inline">Ask Gemini</span>
        </button>
      )}
      {open && <button type="button" aria-label="Close Ask Gemini" onClick={close} className="fixed inset-0 z-40 bg-zinc-950/30 sm:hidden" />}
      <aside role="dialog" aria-modal="false" aria-label="Ask Gemini" aria-hidden={!open}
        className={cx("fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-zinc-200 bg-zinc-50 shadow-2xl transition-transform duration-200 sm:w-[28rem] dark:border-zinc-800 dark:bg-zinc-950",
          open ? "translate-x-0" : "pointer-events-none translate-x-full")}>
        {open && <>
          <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <span className="bg-spark flex size-7 items-center justify-center rounded-full text-white"><Sparkles className="size-4" aria-hidden /></span>
            <h2 className="flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">Ask Gemini</h2>
            <button type="button" onClick={() => choose(null)} disabled={!sessionId} title="Start a new chat"
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-200 dark:hover:bg-zinc-800">
              <Plus className="size-3.5" aria-hidden />New chat
            </button>
            <Link to={sessionId ? `/agent/${sessionId}` : "/agent"} onClick={() => setOpen(false)} title="Open this chat on its own page"
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-200 dark:hover:bg-zinc-800">
              <Maximize2 className="size-3.5" aria-hidden />Open full page
            </Link>
            <button type="button" onClick={close} aria-label="Close" className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><X className="size-4" /></button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <ChatPanel sessionId={sessionId} onSession={choose} info={info.data} compact autoFocus forgetMissing />
          </div>
        </>}
      </aside>
    </>
  );
}
