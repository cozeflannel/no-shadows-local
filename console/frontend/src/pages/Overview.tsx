import { ArrowDownRight, ArrowUpRight, Clock, Gauge, Info, Minus, RefreshCw, ShieldCheck, Sparkles, Timer, Wrench } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useApi } from "../api/hooks";
import type { Derived, ErrorsResponse, FailuresByOncallResponse, KpiResponse, TimeseriesResponse } from "../api/types";
import { BarList, DonutChart, GroupedBars, TimeseriesChart } from "../components/charts";
import { Badge, Button, Card, cx, ErrorState, PageHeader, Segmented, Skeleton, TD, TH, TR, Tooltip } from "../components/ui";
import { useApp } from "../context";
import { fmtMinutes, fmtNum, fmtPct } from "../lib/format";
import { CHART_COLORS, PROTOCOL_LABEL, SOURCE_LABEL, SUPPRESSION_LABEL, TRACK_LABEL } from "../lib/labels";

const LOWER_IS_BETTER = new Set([
  "sent_back_for_edits", "needs_review", "review_bounced", "corrections_reverted", "verdict_overrides", "cases_abandoned", "sla_missed",
  "sla_at_risk", "emails_returned_for_edits", "emails_discarded", "tns_infeasible", "answers_unhelpful", "parity_burson_only", "parity_inhouse_only",
  "oncall_alerts",
]);

const TRIAGE_SERIES = [
  { key: "triage.passed", label: "Passed", color: CHART_COLORS[1] },
  { key: "triage.corrected", label: "Auto-corrected", color: CHART_COLORS[0] },
  { key: "triage.needs_review", label: "Held for review", color: CHART_COLORS[2] },
  { key: "triage.failed", label: "Sent to Burson", color: CHART_COLORS[3] },
  { key: "triage.suppressed", label: "Suppressed", color: "#a1a1aa" },
];
const EMAIL_SERIES = [
  { key: "email.drafted", label: "Drafted", color: CHART_COLORS[6] },
  { key: "email.sent", label: "Sent", color: CHART_COLORS[4] },
  { key: "sla.met", label: "SLA met", color: CHART_COLORS[1] },
  { key: "sla.missed", label: "SLA missed", color: CHART_COLORS[3] },
];

function Delta({ value, previous, lowerIsBetter = false, asPct = false }: { value: number | null | undefined; previous: number | null | undefined; lowerIsBetter?: boolean; asPct?: boolean }) {
  if (value === null || value === undefined || previous === null || previous === undefined) return null;
  const diff = value - previous;
  if (Math.abs(diff) < 1e-9) return <span className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800"><Minus className="size-3" />0</span>;
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  const text = asPct ? `${diff > 0 ? "+" : ""}${(diff * 100).toFixed(1)} pts` : previous > 0 ? `${diff > 0 ? "+" : ""}${Math.round((diff / previous) * 100)}%` : `+${fmtNum(diff)}`;
  return (
    <span className={cx("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium",
      good ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400")}>
      {diff > 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}{text}
    </span>
  );
}

function HeadlineCard({ icon, label, value, help, delta }: { icon: ReactNode; label: string; value: string; help: string; delta?: ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-[#0c0c0f]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">{icon}{label}</span>
        <Tooltip content={help}><Info className="size-3.5 cursor-help text-zinc-400" aria-label={help} /></Tooltip>
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="font-mono text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{value}</span>
        {delta}
      </div>
    </div>
  );
}

function SpeedRow({ label, help, value, sub }: { label: string; help: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <Tooltip content={help}><span className="cursor-help text-sm text-zinc-600 underline decoration-dotted decoration-zinc-300 underline-offset-4 dark:text-zinc-300 dark:decoration-zinc-600">{label}</span></Tooltip>
      <span className="text-right"><span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">{value}</span>{sub && <span className="ml-2 text-xs text-zinc-500">{sub}</span>}</span>
    </div>
  );
}

function slaRows(map: Derived["sla_by_track"], labels: Record<string, string> = {}) {
  return Object.entries(map).map(([k, v]) => ({ label: `${labels[k] ?? k} (${fmtPct(v.pct)})`, met: v.met, missed: v.missed }));
}

export default function OverviewPage() {
  const { meta } = useApp();
  const [days, setDays] = useState(7);
  const [chart, setChart] = useState<"triage" | "email">("triage");
  const kpis = useApi<KpiResponse>("/kpis", { days }, 120_000);
  const tsDays = Math.max(days, 14);
  const ts = useApi<TimeseriesResponse>("/timeseries", { days: tsDays, bucket: "day" }, 300_000);
  const errors = useApi<ErrorsResponse>("/errors", { days });
  const failures = useApi<FailuresByOncallResponse>("/failures-by-oncall", { days });

  const fieldLabel = (f: string) => meta?.field_labels[f] ?? f;
  const actionLabel = useMemo(() => {
    const map = new Map((meta?.actions ?? []).map((a) => [a.code, `${a.emoji} ${a.label}`]));
    return (code: string) => map.get(code) ?? code;
  }, [meta]);

  const reload = () => { kpis.reload(); ts.reload(); errors.reload(); failures.reload(); };
  const k = kpis.data?.kpis;
  const d = kpis.data?.derived;
  const p = kpis.data?.previous;

  return (
    <div>
      <PageHeader
        title="Overview"
        description="What the agent did, how well, and how fast. Hover a metric for its definition (triage_agent.metrics)."
        actions={<>
          <Segmented label="Window" value={days} onChange={setDays} options={[1, 7, 14, 30].map((n) => ({ value: n, label: n === 1 ? "24 h" : `${n} days` }))} />
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload} loading={kpis.loading && !!kpis.data}>Refresh</Button>
        </>}
      />
      <ErrorState error={kpis.error} onRetry={kpis.reload} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {!d || !p ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-xl" />) : <>
          <HeadlineCard icon={<ShieldCheck className="size-3.5" />} label="First-pass yield" value={fmtPct(d.first_pass_yield, 1)}
            help="Share of first submissions that passed QA as received (no corrections, no bounce)." delta={<Delta value={d.first_pass_yield} previous={p.derived.first_pass_yield} asPct />} />
          <HeadlineCard icon={<Wrench className="size-3.5" />} label="Burson bounce rate" value={fmtPct(d.burson_bounce_rate, 1)}
            help="Share of alertable alerts that still had to go back to Burson (unfixable data)." delta={<Delta value={d.burson_bounce_rate} previous={p.derived.burson_bounce_rate} lowerIsBetter asPct />} />
          <HeadlineCard icon={<Sparkles className="size-3.5" />} label="Auto-fix rate" value={fmtPct(d.auto_fix_rate, 1)}
            help="Share of alertable alerts the agent fixed itself instead of asking Burson to retrigger." delta={<Delta value={d.auto_fix_rate} previous={p.derived.auto_fix_rate} asPct />} />
          <HeadlineCard icon={<Timer className="size-3.5" />} label="SLA met" value={fmtPct(d.sla_met_pct, 1)}
            help="Alert emails sent before the platform-tier SLA deadline (strong tier: 15 min)." delta={<Delta value={d.sla_met_pct} previous={p.derived.sla_met_pct} asPct />} />
          <HeadlineCard icon={<Clock className="size-3.5" />} label="Time saved" value={d.time_saved_hours !== undefined ? `${d.time_saved_hours} h` : "—"}
            help={`Avoided Burson retriggers × ${kpis.data?.metrics_config.burson_retrigger_minutes} min + drafted emails × ${kpis.data?.metrics_config.im_minutes_per_alert} min (Settings → Metrics).`}
            delta={<Delta value={d.time_saved_hours} previous={p.derived.time_saved_hours} />} />
          <HeadlineCard icon={<Gauge className="size-3.5" />} label="Parity recall" value={fmtPct(d.parity_recall, 1)}
            help="Share of Burson alerts the in-house pipeline also alerted (Path B)." delta={<Delta value={d.parity_recall} previous={p.derived.parity_recall} asPct />} />
        </>}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Daily activity" subtitle={`Last ${tsDays} days, ${ts.data?.timezone ?? ""}`}
          actions={<Segmented label="Series" value={chart} onChange={setChart} options={[{ value: "triage", label: "Triage verdicts" }, { value: "email", label: "Emails & SLA" }]} />}>
          {ts.data ? <TimeseriesChart rows={ts.data.rows} series={chart === "triage" ? TRIAGE_SERIES : EMAIL_SERIES} stacked={chart === "triage"} /> : <Skeleton className="h-[300px]" />}
        </Card>
        <Card title="Speed" subtitle="Medians (averages) in this window">
          {!d ? <Skeleton className="h-60" /> : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              <SpeedRow label="Post → alert (detection)" help="From the post's publish time to the alert reaching the agent." value={fmtMinutes(d.detect_latency_min.median)} sub={`avg ${fmtMinutes(d.detect_latency_min.avg)}`} />
              <SpeedRow label="Triage latency" help="Agent processing time per alert (parse, rules, Gemini)." value={d.triage_latency_ms.p50 !== null ? `${(d.triage_latency_ms.p50 / 1000).toFixed(1)} s` : "—"} sub={d.triage_latency_ms.avg !== null ? `avg ${(d.triage_latency_ms.avg / 1000).toFixed(1)} s` : undefined} />
              <SpeedRow label="Flag → send" help="From the escalation (auto-draft or 📦) to the IM sending the email." value={fmtMinutes(d.flag_to_send_min.median)} sub={`avg ${fmtMinutes(d.flag_to_send_min.avg)}`} />
              <SpeedRow label="Post → send" help="From the post's publish time to the alert email going out." value={fmtMinutes(d.post_to_send_min.median)} sub={`avg ${fmtMinutes(d.post_to_send_min.avg)}`} />
              <SpeedRow label="Burson time to correction" help="From a bounce to the corrected rerun that passed." value={fmtMinutes(d.time_to_correction_min.median)} sub={`n=${d.time_to_correction_min.n}`} />
              <SpeedRow label="Revisions per email" help="IM revision requests per drafted email." value={d.revisions_per_email !== null ? d.revisions_per_email.toFixed(2) : "—"} />
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="SLA by track" subtitle="Alert emails sent before the deadline">
          {d ? <GroupedBars data={slaRows(d.sla_by_track, TRACK_LABEL)} series={[{ key: "met", label: "Met", color: CHART_COLORS[1] }, { key: "missed", label: "Missed", color: CHART_COLORS[3] }]} /> : <Skeleton className="h-52" />}
        </Card>
        <Card title="SLA by platform tier" subtitle="Strong 15 min · partial 24 h · limited: no SLA">
          {d ? <GroupedBars data={slaRows(d.sla_by_tier)} series={[{ key: "met", label: "Met", color: CHART_COLORS[1] }, { key: "missed", label: "Missed", color: CHART_COLORS[3] }]} /> : <Skeleton className="h-52" />}
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">KPIs · last {days === 1 ? "24 hours" : `${days} days`}</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-4">
        {(kpis.data?.groups ?? []).map((g) => {
          const defs = kpis.data!.definitions.filter((def) => def.group === g.key);
          return (
            <Card key={g.key} title={g.label} subtitle={g.description} bodyClassName="grid grid-cols-2 gap-x-4 gap-y-3">
              {defs.map((def) => (
                <Tooltip key={def.key} content={def.description} className="block">
                  <div className="w-full cursor-help rounded-lg p-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{def.label}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="font-mono text-lg font-semibold text-zinc-950 dark:text-zinc-50">{fmtNum(k?.[def.key])}</span>
                      <Delta value={k?.[def.key]} previous={p?.kpis[def.key]} lowerIsBetter={LOWER_IS_BETTER.has(def.key)} />
                    </div>
                  </div>
                </Tooltip>
              ))}
            </Card>
          );
        })}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Corrections by field" subtitle="Fields the agent fixed instead of bouncing to Burson">
          {d ? <BarList data={Object.entries(d.corrections_by_field).map(([f, n]) => ({ label: fieldLabel(f), value: n }))} valueLabel="Corrections" /> : <Skeleton className="h-60" />}
        </Card>
        <Card title="Suppressed by reason" subtitle="Collection Requirements decisions (not posted)">
          {d ? <BarList color={CHART_COLORS[9]} labelWidth={230} data={Object.entries(d.suppressed_by_reason).map(([r, n]) => ({ label: SUPPRESSION_LABEL[r] ?? r, value: n }))} valueLabel="Alerts" /> : <Skeleton className="h-60" />}
        </Card>
        <Card title="IM actions by emoji" subtitle="Legend reactions the agent carried out">
          {d ? <BarList color={CHART_COLORS[6]} labelWidth={230} data={Object.entries(d.actions_by_code).map(([c, n]) => ({ label: actionLabel(c), value: n }))} valueLabel="Actions" /> : <Skeleton className="h-60" />}
        </Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card title="Protocol pings">
            {d ? <DonutChart data={Object.entries(d.protocol_pings_by_type).map(([k2, n]) => ({ name: PROTOCOL_LABEL[k2] ?? k2, value: n }))} /> : <Skeleton className="h-52" />}
          </Card>
          <Card title="Alerts by source">
            {d ? <DonutChart data={Object.entries(d.alerts_by_source).map(([k2, n]) => ({ name: SOURCE_LABEL[k2] ?? k2, value: n }))} /> : <Skeleton className="h-52" />}
          </Card>
        </div>
        <Card title="Top rule codes" subtitle="Behind bounces and review holds">
          {errors.data ? <BarList color={CHART_COLORS[3]} labelWidth={220} data={errors.data.rule_codes.map((r) => ({ label: r.code, value: r.count }))} valueLabel="Alerts" /> : <Skeleton className="h-52" />}
          {errors.data && errors.data.operation_errors.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="text-xs text-zinc-500">Operation errors:</span>
              {errors.data.operation_errors.map((e) => <Badge key={e.op} tone="rose">{e.op} ×{e.count}</Badge>)}
            </div>
          )}
        </Card>
        <Card title="Bounces by Burson on-call" padded={false}>
          {failures.data && failures.data.rows.length > 0 ? (
            <table className="w-full">
              <thead><tr><th className={TH}>On-call</th><th className={cx(TH, "text-right")}>Bounced alerts</th></tr></thead>
              <tbody>{failures.data.rows.map((r) => (
                <tr key={r.oncall_email} className={TR}><td className={TD}>{r.oncall_email}</td><td className={cx(TD, "text-right font-mono")}>{r.count}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="p-5 text-sm text-zinc-500">{failures.data ? "No bounces in this window." : "Loading…"}</p>}
        </Card>
      </div>
    </div>
  );
}
