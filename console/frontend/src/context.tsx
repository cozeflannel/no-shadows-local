import { CircleCheck, CircleX, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError, apiGet, toApiError } from "./api/client";
import type { Fact, GmailStatus, Me, Meta, OutboxResponse, Proposal, ReviewItem } from "./api/types";
import { cx } from "./components/ui";
import { setDisplayTimezone } from "./lib/format";
import { gmailMissingScopesMessage } from "./lib/labels";
import { setSwitchNames } from "./lib/switches";

type ToastTone = "success" | "error" | "info";
interface Toast { id: number; message: string; tone: ToastTone }
export interface Counts { review: number; learning: number; outbox: number }

interface AppState {
  me: Me | null;
  meta: Meta | null;
  gmail: GmailStatus | null;
  counts: Counts;
  bootError: ApiError | null;
  theme: "light" | "dark";
  toggleTheme: () => void;
  refreshCounts: () => void;
  refreshGmail: () => void;
  /** `sticky` toasts stay until dismissed (for messages the user must act on). */
  toast: (message: string, tone?: ToastTone, options?: { sticky?: boolean }) => void;
  hasOp: (op: string) => boolean;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [counts, setCounts] = useState<Counts>({ review: 0, learning: 0, outbox: 0 });
  const [bootError, setBootError] = useState<ApiError | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));

  const toast = useCallback((message: string, tone: ToastTone = "success", options?: { sticky?: boolean }) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    if (!options?.sticky) window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4500);
  }, []);

  const refreshGmail = useCallback(() => {
    apiGet<GmailStatus>("/gmail/status").then(setGmail).catch(() => setGmail(null));
  }, []);

  const refreshCounts = useCallback(() => {
    Promise.allSettled([
      apiGet<{ cases: ReviewItem[] }>("/review-queue"),
      apiGet<{ proposals: Proposal[]; pending: number }>("/proposals", { status: "PENDING" }),
      apiGet<{ facts: Fact[]; pending: number }>("/facts", { status: "PENDING" }),
      apiGet<OutboxResponse>("/outbox", { undelivered_only: true, limit: 1 }),
    ]).then(([review, proposals, facts, outbox]) => {
      setCounts({
        review: review.status === "fulfilled" ? review.value.cases.length : 0,
        learning: (proposals.status === "fulfilled" ? proposals.value.pending : 0) + (facts.status === "fulfilled" ? facts.value.pending : 0),
        outbox: outbox.status === "fulfilled" ? outbox.value.undelivered : 0,
      });
    });
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    apiGet<Me>("/me")
      .then((value) => {
        if (cancelled) return;
        setDisplayTimezone(value.timezone);
        setMe(value);
        refreshGmail(); // also for users without a Console role (the Triage Agent account connects its mailbox)
        if (!value.can_view) return;
        apiGet<Meta>("/meta").then((m) => { setSwitchNames(m.switch_names); setMeta(m); }).catch((err) => setBootError(toApiError(err)));
        refreshCounts();
        timer = window.setInterval(refreshCounts, 60_000);
      })
      .catch((err) => {
        if (!cancelled) setBootError(toApiError(err));
      });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshCounts, refreshGmail]);

  // Gmail OAuth callback lands on /?gmail=connected|connected_agent|error&reason=…[&missing=compose,metadata&mailbox=im]
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("gmail");
    if (!status) return;
    const reason = params.get("reason");
    if (status === "connected") toast("Gmail connected: drafts will appear in your mailbox (Brand Social alias).");
    else if (status === "connected_agent") toast("Agent mailbox connected: the email doorbell can send now.");
    else if (reason === "missing_scopes") {
      const missing = (params.get("missing") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      toast(gmailMissingScopesMessage(missing, params.get("mailbox")), "error", { sticky: true });
    } else toast(reason || "Couldn't connect Gmail.", "error", { sticky: true });
    for (const key of ["gmail", "reason", "missing", "mailbox"]) params.delete(key);
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
    refreshGmail();
  }, [toast, refreshGmail]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem("console-theme", next);
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);

  const hasOp = useCallback((op: string) => !meta || meta.operations.includes(op), [meta]);

  const value = useMemo<AppState>(
    () => ({ me, meta, gmail, counts, bootError, theme, toggleTheme, refreshCounts, refreshGmail, toast, hasOp }),
    [me, meta, gmail, counts, bootError, theme, toggleTheme, refreshCounts, refreshGmail, toast, hasOp],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[95] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg",
              t.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/50 dark:bg-rose-950 dark:text-rose-200"
                : t.tone === "info" ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800/50 dark:bg-blue-950 dark:text-blue-200"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950 dark:text-emerald-200",
            )}
          >
            {t.tone === "error" ? <CircleX className="mt-0.5 size-4 shrink-0" /> : t.tone === "info" ? <Info className="mt-0.5 size-4 shrink-0" /> : <CircleCheck className="mt-0.5 size-4 shrink-0" />}
            <span className="flex-1 break-words">{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} className="opacity-60 hover:opacity-100"><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
