import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { apiGet } from "../api/client";

export interface LiveItem {
  event_id: string;
  event_ts: string;
  event_type: string;
  case_id: string | null;
  escalation_id: string | null;
  actor: string | null;
  verdict: string | null;
  summary?: string;
  payload: Record<string, unknown>;
  needs?: string;
  case?: { case_id: string; status: string; alert_name: string | null; track: string | null; priority: string | null; product: string | null };
}

export interface NowCounts {
  review_queue: number;
  oldest_review_min: number;
  unacknowledged: number;
  sla_at_risk: number;
  waiting_on_burson: number;
  outbox_waiting: number;
  oldest_outbox_min: number;
  dead_letters: number;
  im_on_shift: string | null;
  im_source: string | null;
  staff_on_shift: number;
}

export type LiveState = "connecting" | "live" | "reconnecting";
type Listener = (items: LiveItem[]) => void;

interface LiveValue { items: LiveItem[]; now: NowCounts | null; state: LiveState; lastEventAt: number; listen: (fn: Listener) => () => void }

const KEPT = 120;
const LiveContext = createContext<LiveValue | null>(null);

/** One stream for the whole Console: the feed so far, the counts that need a person, and each event as it lands. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<LiveItem[]>([]);
  const [now, setNow] = useState<NowCounts | null>(null);
  const [state, setState] = useState<LiveState>("connecting");
  const [lastEventAt, setLastEventAt] = useState(0);
  const seen = useRef(new Set<string>());
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let closed = false;
    const add = (fresh: LiveItem[], arrived: boolean) => {
      const unseen = fresh.filter((i) => !seen.current.has(i.event_id));
      if (!unseen.length) return;
      unseen.forEach((i) => seen.current.add(i.event_id));
      setItems((old) => [...unseen, ...old].sort((a, b) => (a.event_ts < b.event_ts ? 1 : -1)).slice(0, KEPT));
      setLastEventAt(Date.now());
      if (arrived) listeners.current.forEach((fn) => fn(unseen));
    };
    apiGet<{ items: LiveItem[]; now: NowCounts }>("/live/feed", { limit: KEPT })
      .then((r) => {
        if (closed) return;
        add(r.items, false);
        setNow(r.now);
      })
      .catch(() => undefined);
    const source = new EventSource("/api/live/stream");
    source.onopen = () => setState("live");
    source.onerror = () => setState("reconnecting"); // the browser reconnects by itself
    source.addEventListener("events", (e) => add(JSON.parse((e as MessageEvent<string>).data) as LiveItem[], true));
    source.addEventListener("now", (e) => setNow(JSON.parse((e as MessageEvent<string>).data) as NowCounts));
    return () => {
      closed = true;
      source.close();
    };
  }, []);

  const value = useMemo<LiveValue>(() => ({
    items, now, state, lastEventAt,
    listen: (fn) => {
      listeners.current.add(fn);
      return () => { listeners.current.delete(fn); };
    },
  }), [items, now, state, lastEventAt]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function useLiveValue(): LiveValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error("useLive must be used inside <LiveProvider>");
  return value;
}

/** The live feed: the latest `limit` events, the counts that need a person, and whether the stream is connected. */
export function useLive(limit = 80): { items: LiveItem[]; now: NowCounts | null; state: LiveState; lastEventAt: number } {
  const { items, now, state, lastEventAt } = useLiveValue();
  const latest = useMemo(() => items.slice(0, limit), [items, limit]);
  return { items: latest, now, state, lastEventAt };
}

/** Calls `fn` with each batch of events as it arrives on the stream (never with the backlog loaded at the start). */
export function useArrivals(fn: Listener): void {
  const { listen } = useLiveValue();
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => listen((batch) => latest.current(batch)), [listen]);
}
