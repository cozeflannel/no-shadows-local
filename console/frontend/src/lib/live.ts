import { useEffect, useRef, useState } from "react";

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

/** The live event stream: the feed so far, the counts that need a person, and whether the stream is connected. */
export function useLive(limit = 80): { items: LiveItem[]; now: NowCounts | null; state: LiveState; lastEventAt: number } {
  const [items, setItems] = useState<LiveItem[]>([]);
  const [now, setNow] = useState<NowCounts | null>(null);
  const [state, setState] = useState<LiveState>("connecting");
  const [lastEventAt, setLastEventAt] = useState(0);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let closed = false;
    const add = (fresh: LiveItem[]) => {
      const unseen = fresh.filter((i) => !seen.current.has(i.event_id));
      if (!unseen.length) return;
      unseen.forEach((i) => seen.current.add(i.event_id));
      setItems((old) => [...unseen, ...old].sort((a, b) => (a.event_ts < b.event_ts ? 1 : -1)).slice(0, limit));
      setLastEventAt(Date.now());
    };
    apiGet<{ items: LiveItem[]; now: NowCounts }>("/live/feed", { limit })
      .then((r) => {
        if (closed) return;
        add(r.items);
        setNow(r.now);
      })
      .catch(() => undefined);
    const source = new EventSource("/api/live/stream");
    source.onopen = () => setState("live");
    source.onerror = () => setState("reconnecting"); // the browser reconnects by itself
    source.addEventListener("events", (e) => add(JSON.parse((e as MessageEvent<string>).data) as LiveItem[]));
    source.addEventListener("now", (e) => setNow(JSON.parse((e as MessageEvent<string>).data) as NowCounts));
    return () => {
      closed = true;
      source.close();
    };
  }, [limit]);

  return { items, now, state, lastEventAt };
}
