import { ChevronDown, CircleCheck, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { useApi } from "../api/hooks";
import type { KpiDefinition, KpiGroup } from "../api/types";
import { TimeseriesChart } from "../components/charts";
import { ActiveFilters, FilterMenu, RangePicker } from "../components/DashboardFilters";
import { Button, Card, cx, ErrorState, PageHeader, Segmented, Skeleton, Stat, Tooltip } from "../components/ui";
import { useApp } from "../context";
import { DIMENSIONS, useDashboardQuery, type AlertLines, type Breakdown, type DimensionKey, type ResponseStep } from "../lib/dashboard";
import { fmtDuration, fmtMinutes, fmtNum, fmtPct, fmtTime, tzAbbr } from "../lib/format";
import { CHART_COLORS } from "../lib/labels";
import { useLive } from "../lib/live";

interface Dashboard {
  range: string;
  window: { since: string; until: string; bucket: string; timezone: string };
  kpis: Record<string, number>;
  derived: Record<string, any>;
  previous: { kpis: Record<string, number>; derived: Record<string, any> };
  series: Record<string, string | number>[];
  definitions: KpiDefinition[];
  groups: KpiGroup[];
  extra: Record<string, number>;
  alert_lines: AlertLines;
  filtered: boolean;
  as_of: string;
}
interface Setup { steps: { key: string; title: string; done: boolean; detail: string; to: string }[]; done: number; total: number; is_admin: boolean }

// Brand colours only, taken from the shared chart palette by value (a reordered palette can't bring back a yellow).
const pick = (hex: string) => CHART_COLORS.find((c) => c.toLowerCase() === hex) ?? hex;
const BLUE = pick("#4285f4"), GREEN = pick("#34a853"), RED = pick("#ea4335"), VIOLET = pick("#9b72cb"), ROSE = pick("#d96570"), GREY = "#9aa0a6";

const TRIAGE = [
  { key: "triage.passed", label: "Passed as sent", color: GREEN },
  { key: "triage.corrected", label: "Fixed by the agent", color: BLUE },
  { key: "triage.needs_review", label: "Held for review", color: VIOLET },
  { key: "triage.failed", label: "Sent back to Burson", color: RED },
  { key: "triage.suppressed", label: "No alert needed", color: GREY },
];
const EMAIL = [
  { key: "email.drafted", label: "Email drafted", color: VIOLET },
  { key: "email.sent", label: "Email sent", color: BLUE },
  { key: "sla.met", label: "Sent on time", color: GREEN },
  { key: "sla.missed", label: "Sent late", color: RED },
];
// The cards for the lines of a Burson alert, in the order they appear on it.
const LINE_CARDS: { key: DimensionKey; color: string; note?: string }[] = [
  { key: "product", color: BLUE, note: "An alert that names several products counts under each." },
  { key: "social_network", color: VIOLET },
  { key: "exposure_tag", color: ROSE },
  { key: "sensitive_topic", color: RED, note: "An alert with several topics counts under each. None = the line was blank (-)." },
];
const FILTER_ORDER: DimensionKey[] = ["product", "social_network", "exposure_tag", "sensitive_topic", "kof", "kof_list", "sentiment", "verdict", "source"];

function BarRows({ rows, total, color, selected, onPick, empty = "No alert messages in this view." }: {
  rows: Breakdown[]; total: number; color: string; selected: string[]; onPick: (value: string) => void; empty?: string;
}) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-zinc-500">{empty}</p>;
  const max = Math.max(1, ...rows.filter((r) => !r.more).map((r) => r.count));
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const on = selected.includes(r.value);
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-xs">
              <span className={cx("min-w-0 truncate", on ? "font-medium text-blue-700 dark:text-blue-200" : "text-zinc-700 dark:text-zinc-300")} title={r.label}>{r.label}</span>
              <span className="shrink-0 tabular-nums text-zinc-500">{fmtNum(r.count)}{total ? <span className="ml-1.5 text-zinc-400">{Math.round((r.count / total) * 100)}%</span> : null}</span>
            </span>
            <span className="mt-1 block h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800">
              <span className="block h-1.5 rounded-full" style={{ width: `${Math.max(2, (Math.min(r.count, max) / max) * 100)}%`, backgroundColor: color, opacity: r.more ? 0.35 : 1 }} />
            </span>
          </>
        );
        return (
          <li key={r.more ? "(more)" : r.value || "(blank)"}>
            {r.more ? <div className="px-1">{body}</div> : (
              <button type="button" onClick={() => onPick(r.value)} aria-pressed={on} title={on ? `Stop filtering by ${r.label}` : `Show only ${r.label}`}
                className="block w-full rounded-lg px-1 py-0.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60">{body}</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StepRow({ step }: { step: ResponseStep }) {
  return (
    <li className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <Tooltip content={step.description} className="sm:w-56 sm:shrink-0">
        <span className="text-sm font-medium text-zinc-900 underline decoration-zinc-300 decoration-dotted underline-offset-4 dark:text-zinc-100 dark:decoration-zinc-600">{step.label}</span>
      </Tooltip>
      <span className="text-sm text-zinc-700 dark:text-zinc-300">
        {step.recorded_from ? `Not recorded before ${step.recorded_from}` : step.n === 0 ? <span className="text-zinc-500">No alert in this view got to this step.</span> : (
          <>Average <b className="font-medium tabular-nums">{fmtDuration(step.avg_s)}</b><span className="mx-1.5 text-zinc-400">·</span>median <b className="font-medium tabular-nums">{fmtDuration(step.median_s)}</b>
            <span className="mx-1.5 text-zinc-400">·</span><span className="text-zinc-500">over {fmtNum(step.n)} alert{step.n === 1 ? "" : "s"}</span></>
        )}
      </span>
    </li>
  );
}

export default function DashboardPage() {
  const { me } = useApp();
  const navigate = useNavigate();
  const tz = me?.timezone || "America/New_York";
  const q = useDashboardQuery(tz);
  const [chart, setChart] = useState<"triage" | "email">("triage");
  const [showSetup, setShowSetup] = useState(false);
  const [more, setMore] = useState(false);
  const live = useLive(1);
  const fast = q.query.range === "hour" || q.query.range === "today";
  const dash = useApi<Dashboard>(q.customOk ? "/dashboard" : null, q.apiParams, fast ? 30_000 : 180_000);
  const setup = useApi<Setup>(me?.is_admin ? "/setup" : null);

  // New events change today's numbers: read them again shortly after the stream delivers one.
  const { reload } = dash;
  useEffect(() => {
    if (!live.lastEventAt || !fast) return;
    const id = window.setTimeout(reload, 1500);
    return () => window.clearTimeout(id);
  }, [live.lastEventAt, fast, reload]);

  const d = dash.data;
  const lines = d?.alert_lines;
  const k = d?.kpis;
  const p = d?.previous.kpis;
  const now = live.now;
  const delta = (key: string) => (k && p ? (k[key] ?? 0) - (p[key] ?? 0) : null);
  const todo = setup.data?.steps.filter((s) => !s.done) ?? [];
  const dims = lines?.dimensions ?? DIMENSIONS;
  const dim = (key: DimensionKey) => dims.find((x) => x.key === key);
  const selected = (key: DimensionKey) => q.query.filters[key] ?? [];
  const total = lines?.total_messages ?? 0;
  const change = lines ? lines.total_messages - lines.previous_messages : 0;

  return (
    <div>
      <PageHeader title="Dashboard"
        description="Alert messages, counted by the lines on the alert: Product, Social Network, Exposure Tag, Sensitive Topic and KOF. Pick a time range and filters; every number under them follows."
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={dash.reload} loading={dash.loading && !!d}>Refresh</Button>} />

      {todo.length > 0 && setup.data && (
        <Card className="mb-5" padded={false} title={`Setup: ${setup.data.done} of ${setup.data.total} steps done`} subtitle={`Next: ${todo[0].title}`}
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

      <section aria-labelledby="now-title">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <h2 id="now-title" className="text-base font-medium text-zinc-900 dark:text-zinc-100">Right now</h2>
          <p className="text-xs text-zinc-500">Live, for every alert: the time range and filters don't change these.</p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Held for review" value={now ? now.review_queue : "…"} hint={now?.review_queue ? `oldest waiting ${fmtMinutes(now.oldest_review_min)}` : "none waiting"} tone={now?.review_queue ? "rose" : undefined} glow={!!now?.review_queue} onClick={() => navigate("/feed?view=review")} />
          <Stat label="Waiting for an IM" value={now ? now.unacknowledged : "…"} hint="posted, no one has reacted yet" onClick={() => navigate("/feed")} />
          <Stat label="SLA at risk" value={now ? now.sla_at_risk : "…"} hint="due within 5 min, or late" tone={now?.sla_at_risk ? "rose" : undefined} glow={!!now?.sla_at_risk} onClick={() => navigate("/feed")} />
          <Stat label="Sent back to Burson" value={now ? now.waiting_on_burson : "…"} hint="waiting for their fix" onClick={() => navigate("/feed?view=all")} />
          <Stat label="Posts waiting to go out" value={now ? now.outbox_waiting + now.dead_letters : "…"} hint={now?.dead_letters ? `${now.dead_letters} gave up` : now?.outbox_waiting ? `oldest ${fmtMinutes(now.oldest_outbox_min)}` : "none"} tone={now?.dead_letters ? "rose" : undefined} onClick={() => navigate(now?.dead_letters ? "/settings/pubsub" : "/outbox")} />
          <Stat label="IM on shift" value={<span className="text-xl">{now?.im_on_shift ?? "No one"}</span>} hint={now ? `${now.staff_on_shift} scheduled now` : ""} tone={now && !now.staff_on_shift ? "rose" : undefined} onClick={() => navigate("/workforce")} />
        </div>
      </section>

      <Card className="mt-6" bodyClassName="flex flex-col gap-3">
        <RangePicker range={q.query.range} from={q.query.from} to={q.query.to} tzLabel={tz === "America/New_York" ? "Eastern" : tzAbbr()}
          onRange={q.setRange} onDates={q.setDates} />
        {!q.customOk && <p className="text-xs text-rose-600 dark:text-rose-300">The start day must be on or before the end day.</p>}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          {FILTER_ORDER.map((key) => {
            const info = dim(key);
            const options = lines?.options[key] ?? [];
            if (!info || (key === "kof_list" && !options.length && !selected(key).length)) return null;
            return <FilterMenu key={key} dim={info} options={options} selected={selected(key)} onChange={(values) => q.setFilter(key, values)} />;
          })}
          {!lines && <Skeleton className="h-8 w-96 rounded-full" />}
        </div>
        <ActiveFilters dims={dims} options={lines?.options ?? {}} filters={q.query.filters} onRemove={(key, v) => q.toggle(key, v)} onReset={q.reset} canReset={!q.isDefault} />
      </Card>

      <ErrorState error={dash.error} onRetry={dash.reload} />

      <section className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3" aria-label="Totals">
        <div className="glow rounded-2xl bg-white p-5 lg:col-span-1 dark:bg-zinc-900">
          {!lines ? <Skeleton className="h-24" /> : (
            <>
              <p className="text-5xl font-medium tabular-nums tracking-tight text-zinc-950 dark:text-zinc-50">{fmtNum(total)}</p>
              <p className="mt-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">alert message{total === 1 ? "" : "s"} in this view</p>
              <p className="mt-2 text-xs text-zinc-500">
                On {fmtNum(lines.total_alerts)} alert{lines.total_alerts === 1 ? "" : "s"} (a rerun or an engagement update is another message on the same alert).
                {" "}{change === 0 ? "Same as" : `${change > 0 ? "+" : ""}${fmtNum(change)} against`} the period before ({fmtNum(lines.previous_messages)}).
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-3 text-xs dark:border-zinc-800">
                <div><dt className="text-zinc-500">New alerts</dt><dd className="mt-0.5 text-lg font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{fmtNum(lines.new_alerts)}</dd><dd className="text-zinc-500">first message in this view</dd></div>
                <div><dt className="text-zinc-500">{d?.filtered ? "Match the filters" : "Every alert message"}</dt>
                  <dd className="mt-0.5 text-lg font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{lines.messages_in_range ? fmtPct(total / lines.messages_in_range, 0) : "—"}</dd>
                  <dd className="text-zinc-500">of {fmtNum(lines.messages_in_range)} in this time range</dd></div>
              </dl>
              {lines.capped && <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">Only the most recent 20,000 alerts are counted for this range.</p>}
            </>
          )}
        </div>
        <Card title="KOF" subtitle="[KOF] line, and which KOF list the author is on" className="lg:col-span-1">
          {lines ? <>
            <BarRows rows={lines.breakdowns.kof} total={total} color={VIOLET} selected={selected("kof")} onPick={(v) => q.toggle("kof", v)} />
            {lines.breakdowns.kof_list.length > 0 && <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <p className="mb-2 text-xs font-medium text-zinc-500">KOF lists</p>
              <BarRows rows={lines.breakdowns.kof_list} total={0} color={VIOLET} selected={selected("kof_list")} onPick={(v) => q.toggle("kof_list", v)} />
            </div>}
          </> : <Skeleton className="h-28" />}
        </Card>
        <Card title="Sentiment" subtitle="Gemini's read of each post on the Stories page" className="lg:col-span-1">
          {lines ? <>
            <BarRows rows={lines.breakdowns.sentiment} total={total} color={ROSE} selected={selected("sentiment")} onPick={(v) => q.toggle("sentiment", v)} />
            {total > 0 && lines.breakdowns.sentiment.every((b) => b.value === "") && <p className="mt-3 text-xs text-zinc-500">No post here is rated yet. Gemini labels posts when “Gemini reads each story” is on.</p>}
          </> : <Skeleton className="h-28" />}
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2" aria-label="By the lines of the alert">
        {LINE_CARDS.map(({ key, color, note }) => (
          <Card key={key} title={dim(key)?.label ?? key} subtitle={[dim(key)?.line ? `${dim(key)?.line} line` : "", note].filter(Boolean).join(". ")}>
            {lines ? <BarRows rows={lines.breakdowns[key]} total={total} color={color} selected={selected(key)} onPick={(v) => q.toggle(key, v)} /> : <Skeleton className="h-40" />}
          </Card>
        ))}
        <Card title="What the agent decided" subtitle="On each message, when it arrived">
          {lines ? <BarRows rows={lines.breakdowns.verdict} total={total} color={GREEN} selected={selected("verdict")} onPick={(v) => q.toggle("verdict", v)} /> : <Skeleton className="h-40" />}
        </Card>
        <Card title="Came from" subtitle="Burson's alerts, the in-house pipeline, Watchdog emails or pasted by hand">
          {lines ? <BarRows rows={lines.breakdowns.source} total={total} color={BLUE} selected={selected("source")} onPick={(v) => q.toggle("source", v)} /> : <Skeleton className="h-40" />}
        </Card>
      </section>

      <Card className="mt-4" padded={false} title="Response times"
        subtitle={lines ? `From each alert's first message, for the ${fmtNum(lines.new_alerts)} alert${lines.new_alerts === 1 ? "" : "s"} that first arrived in this view. Each step counts only the alerts that got to it.` : undefined}>
        {lines ? <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{lines.response_times.map((s) => <StepRow key={s.key} step={s} />)}</ul> : <Skeleton className="m-5 h-40" />}
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {!d ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />) : <>
          <Stat label="Passed as sent, first try" value={fmtPct(d.derived.first_pass_yield, 0)} hint={`${fmtNum(k?.forwarded_without_edits)} alerts`} />
          <Stat label="Fixed by the agent" value={fmtPct(d.derived.auto_fix_rate, 0)} hint={`${fmtNum(k?.auto_corrected)} alerts, no Burson rerun needed`} />
          <Stat label="Sent back to Burson" value={fmtNum(k?.sent_back_for_edits)} hint="alerts only Burson could fix" />
          <Stat label="Social Alert emails on time" value={fmtPct(d.derived.sla_met_pct, 0)} hint={k?.sla_missed ? `${fmtNum(k.sla_missed)} sent late` : "none late"} tone={k?.sla_missed ? "rose" : undefined} />
        </>}
      </div>

      <Card className="mt-4" title="Over time" subtitle={d ? `${d.window.timezone.replace("_", " ")}, by ${d.window.bucket === "minute" ? "5 minutes" : d.window.bucket}${d.filtered ? ", for the alerts in view" : ""}` : undefined}
        actions={<Segmented label="Show" value={chart} onChange={setChart} options={[{ value: "triage", label: "What the agent decided" }, { value: "email", label: "Emails and SLA" }]} />}>
        {d ? <TimeseriesChart rows={d.series} series={chart === "triage" ? TRIAGE : EMAIL} stacked={chart === "triage"} height={260} /> : <Skeleton className="h-[260px]" />}
      </Card>

      {d && (
        <section className="mt-6">
          <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
            className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-200/70 dark:text-zinc-200 dark:hover:bg-zinc-800">
            <ChevronDown className={cx("size-4 transition-transform", more && "rotate-180")} aria-hidden />Every measure
          </button>
          {more && <>
            <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-4">
              {d.groups.map((g) => (
                <Card key={g.key} title={g.label} subtitle={g.description} bodyClassName="grid grid-cols-2 gap-x-4 gap-y-3">
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
            <div className="mt-4">
              <p className="mb-2 text-xs text-zinc-500">Console and AI use in this time range (the filters don't apply).</p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label="Chat messages" value={fmtNum(d.extra.chat_messages)} hint="in and out" onClick={() => navigate("/chat")} />
                <Stat label="Console actions" value={fmtNum(d.extra.console_actions)} hint="in the audit log" onClick={() => navigate("/settings/audit")} />
                <Stat label="Messages held" value={fmtNum(d.extra.blocked_messages)} hint="by a safety check" tone={d.extra.blocked_messages ? "rose" : undefined} onClick={() => navigate("/settings/safety")} />
                <Stat label="Gemini calls" value={fmtNum(d.extra.llm_calls)} hint={d.extra.llm_errors ? `${d.extra.llm_errors} failed` : "none failed"} tone={d.extra.llm_errors ? "rose" : undefined} onClick={() => navigate("/settings/costs")} />
                <Stat label="Temp checks" value={fmtNum(d.extra.temp_checks)} hint="finished" onClick={() => navigate("/temp-check")} />
              </div>
            </div>
            <p className="mt-3 text-xs"><Link to="/breakdowns" className="font-medium text-blue-700 dark:text-blue-200">Breakdowns by tag, error and on-call</Link></p>
          </>}
        </section>
      )}

      {setup.data && todo.length === 0 && <p className="mt-6 flex items-center gap-1.5 text-xs text-zinc-500"><CircleCheck className="size-3.5 text-emerald-500" />Setup is complete.</p>}
      {d && <p className="mt-2 text-xs text-zinc-500">Numbers as of {fmtTime(d.as_of)}.</p>}
    </div>
  );
}
