import { ArrowDown, ArrowUp, Inbox, Plus, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { ChatThreads, type ChatSpace } from "../components/ChatActivity";
import { Badge, Button, CaseBadges, cx, EmptyState, ErrorState, Input, Modal, PageHeader, Segmented, Select, Spinner, Tabs, Textarea, Toggle } from "../components/ui";
import { useVelocityMap } from "../components/VelocityInline";
import { AgentAlertWorkspace, AlertWorkspace } from "../components/workspace/AlertWorkspace";
import type { AgentAlert, FeedCard, FeedList } from "../components/workspace/types";
import { useApp } from "../context";
import { fmtDate, fmtNum, fmtTime } from "../lib/format";
import { useLive } from "../lib/live";

type View = "action" | "review" | "verified" | "suppressed" | "closed" | "all" | "passed";
type Kind = "all" | "burson" | "agent" | "chat";
type SortKey = "name" | "status" | "product" | "network" | "priority" | "engagement" | "at";
interface Row {
  key: string; kind: "case" | "agent"; id: string; name: string; named: boolean; status: string; product: string; network: string; priority: string;
  engagement: number | null; at: string; rank: number; card?: FeedCard; alert?: AgentAlert;
}

const VIEWS: { value: View; label: string }[] = [
  { value: "action", label: "Needs action" }, { value: "review", label: "Review" }, { value: "verified", label: "Verified" },
  { value: "suppressed", label: "Suppressed" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" },
];
/** The agent's own alerts have their own three views: what waits for a verdict, all it raised, and what it looked at and did not raise. */
const AGENT_VIEWS: { value: View; label: string }[] = [{ value: "action", label: "To judge" }, { value: "all", label: "Raised" }, { value: "passed", label: "Not raised" }];
const NEED_RANK: Record<string, number> = { sla: 0, review: 1, verdict: 1, acknowledge: 2, source_fix: 3 };
const COLS = "grid grid-cols-[2.25rem_minmax(0,1fr)_6.5rem_4.75rem] items-center gap-x-3 md:grid-cols-[2.25rem_minmax(0,1fr)_10rem_9rem_6.5rem_4.75rem] xl:grid-cols-[2.25rem_minmax(0,1fr)_10rem_9rem_7rem_4rem_6.5rem_6.5rem_4.75rem]";
const HEAD: { key: SortKey; label: string; show: string }[] = [
  { key: "name", label: "Alert", show: "flex" }, { key: "status", label: "Status", show: "hidden md:flex" }, { key: "product", label: "Product", show: "hidden md:flex" },
  { key: "network", label: "Network", show: "hidden xl:flex" }, { key: "priority", label: "Priority", show: "hidden xl:flex" },
  { key: "engagement", label: "Engagement", show: "hidden xl:flex justify-end" }, { key: "at", label: "Date and time", show: "flex col-span-2" },
];
const VERDICT: Record<string, string> = { TRUE_POSITIVE: "Confirmed", FALSE_POSITIVE: "False positive" };

function rowsOf(list: FeedList | null): Row[] {
  const cases: Row[] = (list?.cards ?? []).map((c) => ({
    key: c.case_id, kind: "case", id: c.case_id, name: c.alert_name || c.issue_name || "No alert name yet", named: !!(c.alert_name || c.issue_name), status: c.needs || c.status,
    product: c.product ?? "", network: c.platform ?? "", priority: c.priority ?? "", engagement: typeof c.engagement_total === "number" ? c.engagement_total : null,
    at: c.latest_received_at, rank: NEED_RANK[c.needs] ?? 4, card: c,
  }));
  const agent: Row[] = (list?.agent_alerts ?? []).map((a) => ({
    key: `agent:${a.id}`, kind: "agent", id: a.id, name: a.title, named: true, status: a.verdict ? VERDICT[a.verdict] : a.status === "passed" ? "Not raised" : "To judge", product: "", network: "",
    priority: a.severity, engagement: null, at: a.at, rank: NEED_RANK[a.needs] ?? 4, alert: a,
  }));
  return [...cases, ...agent];
}

function sorted(rows: Row[], view: View, sort: { key: SortKey; desc: boolean } | null): Row[] {
  const out = [...rows];
  if (!sort) {  // as the work comes: what waits first (the longest wait on top), else the newest first
    out.sort((a, b) => (view === "action" ? a.rank - b.rank || a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
    return out;
  }
  const dir = sort.desc ? -1 : 1;
  out.sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    if (typeof x === "number" || typeof y === "number") return dir * ((x as number | null ?? -1) - (y as number | null ?? -1));
    return dir * String(x ?? "").localeCompare(String(y ?? ""), undefined, { sensitivity: "base" });
  });
  return out;
}

function StatusCell({ row }: { row: Row }): ReactNode {
  if (row.card) return <CaseBadges status={row.card.status} verdict={null} need={row.card.needs} />;
  return <Badge tone={row.alert?.verdict === "TRUE_POSITIVE" ? "emerald" : row.alert?.verdict || row.alert?.status === "passed" ? "zinc" : "violet"}>{row.status}</Badge>;
}

/** One alert as one line: its name, where it stands, and when it came in. An alert the agent raised itself has the lit edge. */
function Line({ row, n, selected, full, onOpen }: { row: Row; n: number; selected: boolean; full: boolean; onOpen: () => void }) {
  const own = row.kind === "agent";
  const agent = own && row.alert?.status !== "passed";  // what it did not raise is not an alert: no lit edge
  return (
    <li className={cx(agent && "glow my-1 rounded-xl", !agent && "border-b border-zinc-100 last:border-0 dark:border-zinc-800/70")}>
      <button type="button" onClick={onOpen} aria-current={selected}
        className={cx(COLS, "w-full px-3 py-1.5 text-left text-sm transition-colors", agent && "rounded-xl",
          selected ? "bg-blue-50 dark:bg-blue-200/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50")}>
        <span className="text-right text-xs tabular-nums text-zinc-400">{n}</span>
        <span className="flex min-w-0 items-center gap-2">
          {own && <Sparkles className={cx("size-3.5 shrink-0", agent ? "text-violet-500" : "text-zinc-400")} aria-label={agent ? "Raised by the agent" : "Looked at by the agent, not raised"} />}
          <span className={cx("truncate font-medium", row.named ? "text-blue-700 dark:text-blue-200" : "text-zinc-500")}>{row.name}</span>
          <span className="hidden shrink-0 font-mono text-[11px] text-zinc-400 sm:inline">{agent ? "Agent alert" : own ? "Not raised" : row.id}</span>
        </span>
        <span className="hidden min-w-0 items-center gap-1 md:flex"><StatusCell row={row} /></span>
        <span className="hidden truncate text-zinc-700 md:block dark:text-zinc-300">{row.product}</span>
        <span className="hidden truncate text-zinc-700 xl:block dark:text-zinc-300">{row.network}</span>
        <span className="hidden text-zinc-700 xl:block dark:text-zinc-300">{row.priority}</span>
        <span className="hidden text-right tabular-nums text-zinc-700 xl:block dark:text-zinc-300">{row.engagement === null ? "" : fmtNum(row.engagement)}</span>
        <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{fmtDate(row.at)}</span>
        <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{fmtTime(row.at)}</span>
      </button>
      {full && (
        <pre className="scroll-thin mx-3 mb-2 ml-[3.75rem] max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100 p-3 font-sans text-[13px] leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          {row.card ? row.card.alert_text || "The message was not kept." : [row.alert?.rationale, row.alert?.evidence].filter(Boolean).join("\n\n")}
        </pre>
      )}
    </li>
  );
}

/** The list beside an open alert: name and time, to step to the next one without closing. It sits just under the alert's
 *  window in the stacking order (they never overlap), so what the window opens over itself also covers this list. */
function Rail({ rows, current, onOpen }: { rows: Row[]; current: string; onOpen: (row: Row) => void }) {
  return (
    <aside aria-label="Alerts" className="fixed inset-y-2 right-2 z-[64] hidden flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl xl:flex dark:border-zinc-800 dark:bg-zinc-900"
      style={{ left: "calc(var(--nav-w, 0rem) + (100vw - var(--nav-w, 0rem)) * 0.8 + 1rem)" }}>
      <p className="border-b border-zinc-200 px-3 py-2.5 text-xs font-medium text-zinc-500 dark:border-zinc-800">{rows.length} {rows.length === 1 ? "alert" : "alerts"}</p>
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {rows.map((r) => (
          <li key={r.key} className={cx(r.kind === "agent" && r.alert?.status !== "passed" && "glow my-1 rounded-lg")}>
            <button type="button" onClick={() => onOpen(r)} aria-current={r.key === current} title={r.name}
              className={cx("flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", r.key === current ? "bg-blue-100 text-blue-900 dark:bg-blue-200/15 dark:text-blue-100" : "hover:bg-zinc-100 dark:hover:bg-zinc-800")}>
              <span className={cx("min-w-0 flex-1 truncate", r.named ? "font-medium" : "text-zinc-500")}>{r.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{fmtTime(r.at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export default function FeedPage() {
  const { me, toast, refreshCounts } = useApp();
  const { caseId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const kind = (search.get("kind") as Kind) || "all";
  const wanted = (search.get("view") as View) || "action";
  const views = kind === "agent" ? AGENT_VIEWS : VIEWS;
  const view: View = views.some((v) => v.value === wanted) ? wanted : "action";  // a view of the other list falls back to what waits
  const full = search.get("full") === "1";
  const agentId = search.get("agent");
  const space = search.get("space") ?? "";
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [hours, setHours] = useState(72);
  const [intake, setIntake] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const chat = kind === "chat";
  const list = useApi<FeedList>(chat ? null : "/feed", { view, q: query, hours: view === "action" ? 72 : kind === "agent" ? 720 : 168, kind, full, limit: 200 }, 60_000);
  const spaces = useApi<{ spaces: ChatSpace[] }>(chat ? "/chat/spaces" : null, { hours });
  const live = useLive(20);
  const { reload } = list;
  useEffect(() => {
    if (!live.lastEventAt) return;
    const id = window.setTimeout(reload, 800);
    return () => window.clearTimeout(id);
  }, [live.lastEventAt, reload]);
  useEffect(() => { const id = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(id); }, [q]);
  const changed = useCallback(() => { reload(); refreshCounts(); }, [reload, refreshCounts]);

  const set = useCallback((changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) { if (v === null || v === "") next.delete(k); else next.set(k, v); }
    setSearch(next, { replace: true });
  }, [search, setSearch]);
  const params = useCallback((drop: string[] = []) => {
    const next = new URLSearchParams(search);
    for (const k of drop) next.delete(k);
    const s = next.toString();
    return s ? `?${s}` : "";
  }, [search]);
  const open = useCallback((row: Row) => {
    if (row.kind === "case") navigate(`/feed/${row.id}${params(["agent"])}`);
    else { const next = new URLSearchParams(search); next.set("agent", row.id); navigate(`/feed?${next}`); }
  }, [navigate, params, search]);
  const close = useCallback(() => navigate(`/feed${params(["agent"])}`), [navigate, params]);

  const submit = async () => {
    setSending(true);
    try {
      const res = await apiSend<{ case_id?: string; summary?: string; data?: { user_error?: string } }>("post", "/intake", { text });
      if (res.case_id) { toast(res.summary || `Triaged as ${res.case_id}`); setIntake(false); setText(""); changed(); navigate(`/feed/${res.case_id}`); }
      else toast(res.data?.user_error || res.summary || "That text is not an alert.", "error");
    } catch (err) {
      toast((err as ApiError).message, "error");
    } finally {
      setSending(false);
    }
  };

  const rows = useMemo(() => sorted(rowsOf(list.data), view, sort), [list.data, view, sort]);
  const vel = useVelocityMap({ caseIds: [caseId] });
  // An agent alert opened by its link (from Chat, or an older one) may not be in the list on screen: it is fetched by its id.
  const listed = agentId ? list.data?.agent_alerts.find((a) => a.id === agentId) : undefined;
  const single = useApi<AgentAlert>(agentId && !caseId && list.data && !listed ? `/feed/agent-alerts/${encodeURIComponent(agentId)}` : null);
  const agentAlert = listed ?? (agentId && single.data?.id === agentId ? single.data : undefined);
  const opened = !!caseId || !!agentAlert;

  // A Confirm or False positive link on the alert in Chat opens the feed with the alert and the verdict: it is recorded once.
  const asked = search.get("verdict");
  const canAct = !!me?.can_act;
  const linked = useRef(false);
  const reloadSingle = single.reload;
  useEffect(() => {
    if (linked.current || !agentId || !canAct || (asked !== "TRUE_POSITIVE" && asked !== "FALSE_POSITIVE")) return;
    linked.current = true;
    set({ verdict: null });
    apiSend("post", `/own/decisions/${encodeURIComponent(agentId)}/verdict`, { verdict: asked })
      .then(() => { toast(VERDICT[asked], "success"); changed(); reloadSingle(); })
      .catch((err: unknown) => toast((err as ApiError).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, asked, canAct]);
  const sortedBy = sort ? `${HEAD.find((h) => h.key === sort.key)?.label ?? ""} ${sort.desc ? "(Z to A)" : "(A to Z)"}` : view === "action" ? "what waits longest" : "newest first";
  const total = (list.data?.total ?? 0) + (list.data?.agent_total ?? 0);

  return (
    <div>
      <PageHeader title="Review feed" description="Every alert to work, a line each. Open one to write its email, file its Trust & Safety form, run a temp check and grade the chatbot."
        actions={<>
          <div className="relative w-full sm:w-auto"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-zinc-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this list" aria-label="Search" className="w-full pl-9 sm:w-56" /></div>
          {me?.can_act && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setIntake(true)}>Triage an alert</Button>}
        </>} />
      <Tabs<Kind> value={kind} onChange={(k) => set({ kind: k === "all" ? null : k })} tabs={[
        { key: "all", label: "All alerts" }, { key: "burson", label: "Burson's alerts" },
        { key: "agent", label: "Agent alerts", count: kind === "chat" ? undefined : list.data?.agent_total }, { key: "chat", label: "Chat messages" }]} />
      <ErrorState error={list.error} onRetry={list.reload} />
      {agentId && !agentAlert && <ErrorState error={single.error} />}

      <section className="rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <p className="min-w-0 flex-1 text-xs text-zinc-500">
            {chat ? "What the agent read and posted in Chat, a conversation a line" : <>
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{rows.length} {rows.length === 1 ? "item" : "items"}</span>
              {total > rows.length && ` of ${total}`} · Sorted by {sortedBy} · Filtered by {views.find((v) => v.value === view)?.label}
              {list.data?.as_of && ` · Updated ${fmtTime(list.data.as_of)}`}
              {kind === "agent" && <> · What it alerts on is set by its <Link to="/settings/own-sources" className="font-medium text-blue-600 dark:text-blue-200">sources</Link> and <Link to="/settings/own-rules" className="font-medium text-blue-600 dark:text-blue-200">rules</Link>, in Settings</>}
            </>}
          </p>
          <Toggle checked={full} onChange={(v) => set({ full: v ? "1" : null })} label="Full messages" />
          {chat ? <>
            <Select value={space} onChange={(e) => set({ space: e.target.value })} aria-label="Space" className="w-auto">
              <option value="">Every space</option>{(spaces.data?.spaces ?? []).map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </Select>
            <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: 24, label: "24 h" }, { value: 72, label: "3 days" }, { value: 168, label: "7 days" }]} />
          </> : <Segmented label="View" value={view} onChange={(v) => set({ view: v === "action" ? null : v })} options={views} />}
        </header>

        {chat ? <ChatThreads hours={hours} space={space} direction="" q={query} full={full} /> : (
          <>
            <div className={cx(COLS, "border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900")}>
              <span />
              {HEAD.map((h) => (
                <button key={h.key} type="button" onClick={() => setSort((s) => (s?.key === h.key ? (s.desc ? null : { key: h.key, desc: true }) : { key: h.key, desc: false }))}
                  title={`Sort by ${h.label.toLowerCase()}`} className={cx("items-center gap-1 text-left hover:text-zinc-900 dark:hover:text-zinc-100", h.show)}>
                  {h.label}{sort?.key === h.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                </button>
              ))}
            </div>
            {list.loading && !list.data ? <Spinner /> : rows.length === 0 ? (
              <EmptyState icon={<Inbox className="size-8" />} title={view === "passed" ? "Nothing was turned down in the last 30 days" : view === "action" ? "Nothing is waiting" : "No alerts in this view"}>
                {view === "passed" ? "Posts and stories Gemini looked at and decided not to raise show here, with the reason."
                  : kind === "agent" ? (view === "action" ? "An alert the agent raises shows here until someone confirms it or marks it a false positive." : "When the agent raises an alert, it shows here with its posts and the reason.")
                    : view === "action" ? "New alerts appear here the moment they are triaged." : "Try another view or a wider search."}
              </EmptyState>
            ) : (
              <ul className="px-1 py-1">
                {rows.map((r, i) => <Line key={r.key} row={r} n={i + 1} full={full} selected={r.kind === "case" ? r.id === caseId : r.id === agentId} onOpen={() => open(r)} />)}
              </ul>
            )}
          </>
        )}
      </section>

      {opened && <button type="button" aria-label="Close the alert" onClick={close} className="fixed inset-y-0 right-0 z-[64] cursor-default bg-zinc-950/45 backdrop-blur-[1px]" style={{ left: "var(--nav-w, 0rem)" }} />}
      {caseId && <AlertWorkspace key={caseId} caseId={caseId} velocity={vel.find(caseId)} onVelocityUpdated={vel.updateOne} onClose={close} onChanged={changed} />}
      {!caseId && agentAlert && <AgentAlertWorkspace key={agentAlert.id} alert={agentAlert} canAct={!!me?.can_act} onClose={close} onChanged={changed} />}
      {opened && <Rail rows={rows} current={caseId ?? `agent:${agentId}`} onOpen={open} />}

      <Modal open={intake} title="Triage an alert" onClose={() => setIntake(false)} wide
        footer={<><Button onClick={() => setIntake(false)}>Cancel</Button><Button variant="primary" loading={sending} disabled={!text.trim()} onClick={submit}>Triage</Button></>}>
        <p className="mb-3 text-sm text-zinc-500">Paste the alert exactly as it was posted. It goes through the same triage as an alert from Chat and becomes a real case.</p>
        <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} aria-label="Alert text" className="font-sans text-sm" />
      </Modal>
    </div>
  );
}
