import { ArrowRight, CircleCheck, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { useApi } from "../api/hooks";
import type { KpiDefinition, KpiGroup } from "../api/types";
import { TimeseriesChart } from "../components/charts";
import { Badge, Button, Card, cx, Dot, ErrorState, Input, PageHeader, Segmented, Skeleton, Stat, Tooltip } from "../components/ui";
import { useApp } from "../context";
import { fmtMinutes, fmtNum, fmtPct, fmtRelative, fmtTime } from "../lib/format";
import { CHART_COLORS } from "../lib/labels";
import { useLive, type LiveItem } from "../lib/live";

type RangeName = "hour" | "today" | "24h" | "7d" | "30d" | "custom";

interface Dashboard {
  range: RangeName;
  window: { since: string; until: string; bucket: string; timezone: string };
  kpis: Record<string, number>;
  derived: Record<string, any>;
  previous: { kpis: Record<string, number>; derived: Record<string, any> };
  series: Record<string, string | number>[];
  definitions: KpiDefinition[];
  groups: KpiGroup[];
  extra: Record<string, number>;
  as_of: string;
}
interface Setup { steps: { key: string; title: string; done: boolean; detail: string; to: string }[]; done: number; total: number; is_admin: boolean }

const RANGES: { value: RangeName; label: string }[] = [
  { value: "hour", label: "Hour" }, { value: "today", label: "Today" }, { value: "24h", label: "24 h" },
  { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "custom", label: "Custom" },
];
const TRIAGE = [
  { key: "triage.passed", label: "Passed", color: CHART_COLORS[1] },
  { key: "triage.corrected", label: "Corrected", color: CHART_COLORS[0] },
  { key: "triage.needs_review", label: "Held for review", color: CHART_COLORS[2] },
  { key: "triage.failed", label: "Sent back", color: CHART_COLORS[3] },
  { key: "triage.suppressed", label: "Suppressed", color: "#9aa0a6" },
];
const EMAIL = [
  { key: "email.drafted", label: "Drafted", color: CHART_COLORS[4] },
  { key: "email.sent", label: "Sent", color: CHART_COLORS[0] },
  { key: "sla.met", label: "SLA met", color: CHART_COLORS[1] },
  { key: "sla.missed", label: "SLA missed", color: CHART_COLORS[3] },
];
const NEEDS: Record<string, { label: string; tone: "rose" | "amber" | "blue" }> = {
  sla: { label: "SLA at risk", tone: "rose" }, review: { label: "Review", tone: "amber" },
  acknowledge: { label: "Acknowledge", tone: "blue" }, source_fix: { label: "Waiting on source", tone: "amber" },
};

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function FeedRow({ item }: { item: LiveItem }) {
  const need = item.needs ? NEEDS[item.needs] : undefined;
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className="w-14 shrink-0 pt-0.5 text-xs tabular-nums text-zinc-500" title={fmtRelative(item.event_ts)}>{fmtTime(item.event_ts)}</span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-zinc-800 dark:text-zinc-200">{item.summary || item.event_type}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
          {item.case && <span className="truncate">{item.case.alert_name || item.case.case_id}</span>}
          {item.case?.product && <span>{item.case.product}</span>}
          {item.actor && item.actor !== "agent" && <span>{item.actor}</span>}
        </p>
      </div>
      {item.case_id && (
        <Link to={`/feed/${item.case_id}`} className={cx("inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-medium",
          need ? "bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-200 dark:text-blue-900" : "text-blue-600 hover:bg-blue-50 dark:text-blue-200 dark:hover:bg-zinc-800")}>
          {need ? need.label : item.case_id}<ArrowRight className="size-3" />
        </Link>
      )}
    </li>
  );
}

export default function DashboardPage() {
  const { me } = useApp();
  const navigate = useNavigate();
  const [range, setRange] = useState<RangeName>("today");
  const [from, setFrom] = useState(() => toLocalInput(new Date(Date.now() - 3 * 86400_000)));
  const [to, setTo] = useState(() => toLocalInput(new Date()));
  const [chart, setChart] = useState<"triage" | "email">("triage");
  const [showSetup, setShowSetup] = useState(false);
  const live = useLive(60);
  const params = useMemo(() => (range === "custom" ? { range, from: new Date(from).toISOString(), to: new Date(to).toISOString() } : { range }), [range, from, to]);
  const customOk = range !== "custom" || (from && to && new Date(from) < new Date(to));
  const dash = useApi<Dashboard>(customOk ? "/dashboard" : null, params, range === "hour" || range === "today" ? 30_000 : 180_000);
  const setup = useApi<Setup>(me?.is_admin ? "/setup" : null);

  // New events change today's numbers: read them again shortly after the stream delivers one.
  const { reload } = dash;
  useEffect(() => {
    if (!live.lastEventAt || (range !== "hour" && range !== "today")) return;
    const id = window.setTimeout(reload, 1500);
    return () => window.clearTimeout(id);
  }, [live.lastEventAt, range, reload]);

  const d = dash.data;
  const k = d?.kpis;
  const p = d?.previous.kpis;
  const now = live.now;
  const delta = (key: string) => (k && p ? (k[key] ?? 0) - (p[key] ?? 0) : null);
  const todo = setup.data?.steps.filter((s) => !s.done) ?? [];

  return (
    <div>
      <PageHeader title="Dashboard"
        actions={<>
          {range === "custom" && <>
            <Input type="datetime-local" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="w-auto" />
            <Input type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" className="w-auto" />
          </>}
          <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={dash.reload} loading={dash.loading && !!d}>Refresh</Button>
        </>} />

      {todo.length > 0 && setup.data && (
        <Card className="glow mb-5 border-transparent dark:border-transparent" padded={false}
          title={`Setup: ${setup.data.done} of ${setup.data.total} steps done`} subtitle={`Next: ${todo[0].title}`}
          actions={<>
            <Link to={todo[0].to} className="rounded-full bg-blue-600 px-4 py-1.5 text-xs font-medium text-white dark:bg-blue-200 dark:text-blue-900">Open the next step</Link>
            <Button size="sm" variant="ghost" onClick={() => setShowSetup((v) => !v)} aria-expanded={showSetup}>{showSetup ? "Hide steps" : `Show all ${todo.length}`}</Button>
          </>}>
          {showSetup && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {todo.map((s) => (
                <li key={s.key} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0 flex-1"><span className="font-medium text-zinc-900 dark:text-zinc-100">{s.title}</span><span className="ml-2 text-zinc-500">{s.detail}</span></span>
                  <Link to={s.to} className="shrink-0 rounded-full px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-200 dark:hover:bg-zinc-800">Open</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Review queue" value={now ? now.review_queue : "…"} hint={now?.review_queue ? `oldest ${fmtMinutes(now.oldest_review_min)}` : "clear"} tone={now?.review_queue ? "amber" : undefined} glow={!!now?.review_queue} onClick={() => navigate("/feed?view=review")} />
        <Stat label="To acknowledge" value={now ? now.unacknowledged : "…"} hint="verified, no one has it yet" onClick={() => navigate("/feed")} />
        <Stat label="SLA at risk" value={now ? now.sla_at_risk : "…"} hint="due within 5 min or late" tone={now?.sla_at_risk ? "rose" : undefined} glow={!!now?.sla_at_risk} onClick={() => navigate("/feed")} />
        <Stat label="Waiting on Burson" value={now ? now.waiting_on_burson : "…"} hint="sent back for a fix" onClick={() => navigate("/feed?view=all")} />
        <Stat label="Deliveries waiting" value={now ? now.outbox_waiting + now.dead_letters : "…"} hint={now?.dead_letters ? `${now.dead_letters} gave up` : now?.outbox_waiting ? `oldest ${fmtMinutes(now.oldest_outbox_min)}` : "none"} tone={now?.dead_letters ? "rose" : undefined} onClick={() => navigate(now?.dead_letters ? "/settings/pubsub" : "/outbox")} />
        <Stat label="On shift" value={<span className="text-xl">{now?.im_on_shift ?? "No one"}</span>} hint={now ? `${now.staff_on_shift} scheduled` : ""} tone={now && !now.staff_on_shift ? "rose" : undefined} onClick={() => navigate("/workforce")} />
      </div>

      <ErrorState error={dash.error} onRetry={dash.reload} />

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-5">
        <div className="space-y-5 xl:col-span-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {!d ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />) : <>
              <Stat label="Alerts received" value={fmtNum(k?.alerts_received)} delta={delta("alerts_received")} hint="against the period before" />
              <Stat label="First-pass yield" value={fmtPct(d.derived.first_pass_yield, 0)} hint="passed as received" />
              <Stat label="Fixed by the agent" value={fmtPct(d.derived.auto_fix_rate, 0)} hint={`${fmtNum(k?.auto_corrected)} corrected`} />
              <Stat label="SLA met" value={fmtPct(d.derived.sla_met_pct, 0)} hint={`${fmtNum(k?.sla_missed)} missed`} tone={k?.sla_missed ? "amber" : undefined} />
            </>}
          </div>
          <Card title="Activity" subtitle={d ? `${d.window.timezone}, by ${d.window.bucket === "minute" ? "5 minutes" : d.window.bucket}` : undefined}
            actions={<Segmented label="Series" value={chart} onChange={setChart} options={[{ value: "triage", label: "Triage" }, { value: "email", label: "Emails & SLA" }]} />}>
            {d ? <TimeseriesChart rows={d.series} series={chart === "triage" ? TRIAGE : EMAIL} stacked={chart === "triage"} height={280} /> : <Skeleton className="h-[280px]" />}
          </Card>
          {d && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Chat messages" value={fmtNum(d.extra.chat_messages)} hint="in and out" onClick={() => navigate("/chat")} />
              <Stat label="Console actions" value={fmtNum(d.extra.console_actions)} hint="audited" onClick={() => navigate("/settings/audit")} />
              <Stat label="Messages held" value={fmtNum(d.extra.blocked_messages)} hint="by a safety check" tone={d.extra.blocked_messages ? "amber" : undefined} onClick={() => navigate("/settings/safety")} />
              <Stat label="Gemini calls" value={fmtNum(d.extra.llm_calls)} hint={d.extra.llm_errors ? `${d.extra.llm_errors} failed` : "none failed"} tone={d.extra.llm_errors ? "amber" : undefined} onClick={() => navigate("/settings/costs")} />
              <Stat label="Temp checks" value={fmtNum(d.extra.temp_checks)} hint="completed" onClick={() => navigate("/temp-check")} />
            </div>
          )}
        </div>

        <Card className="h-fit xl:col-span-2" padded={false}
          title={<span className="flex items-center gap-2">Live<Dot tone={live.state === "live" ? "emerald" : "amber"} pulse={live.state === "live"} />
            <span className="text-xs font-normal text-zinc-500">{live.state === "live" ? "streaming" : live.state === "connecting" ? "connecting" : "reconnecting"}</span></span>}
          actions={<Link to="/feed" className="text-xs font-medium text-blue-600 dark:text-blue-200">Open the review feed</Link>}>
          {live.items.length === 0 ? <p className="px-5 py-10 text-center text-sm text-zinc-500">Nothing in the last 6 hours. New events appear here as they happen.</p> : (
            <ul className="scroll-thin max-h-[640px] divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">{live.items.map((i) => <FeedRow key={i.event_id} item={i} />)}</ul>
          )}
        </Card>
      </div>

      {d && (
        <div className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">All measures</h2>
            <Link to="/breakdowns" className="text-xs font-medium text-blue-600 dark:text-blue-200">Breakdowns by tag, error and on-call</Link>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-4">
            {d.groups.map((g) => (
              <Card key={g.key} title={g.label} bodyClassName="grid grid-cols-2 gap-x-4 gap-y-3">
                {d.definitions.filter((def) => def.group === g.key).map((def) => {
                  const diff = delta(def.key);
                  return (
                    <Tooltip key={def.key} content={def.description} className="block">
                      <div className="w-full">
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{def.label}</p>
                        <p className="mt-0.5 flex items-baseline gap-2">
                          <span className="text-lg font-medium tabular-nums text-zinc-950 dark:text-zinc-50">{fmtNum(k?.[def.key])}</span>
                          {!!diff && <span className="text-xs tabular-nums text-zinc-500">{diff > 0 ? "+" : ""}{diff}</span>}
                        </p>
                      </div>
                    </Tooltip>
                  );
                })}
              </Card>
            ))}
          </div>
        </div>
      )}
      {setup.data && todo.length === 0 && <p className="mt-6 flex items-center gap-1.5 text-xs text-zinc-500"><CircleCheck className="size-3.5 text-emerald-500" />Setup is complete.</p>}
      {d && <p className="mt-2 text-xs text-zinc-500">Numbers as of {fmtTime(d.as_of)}. <Badge tone="zinc">{d.range === "custom" ? "custom range" : RANGES.find((r) => r.value === d.range)?.label}</Badge></p>}
    </div>
  );
}
