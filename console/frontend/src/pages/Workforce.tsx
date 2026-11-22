import { CalendarClock, Download, Play, UsersRound } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, Modal, OffNotice, PageHeader, Segmented, Select, Skeleton, Stat, Tabs, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";
import { fmtDateTime, fmtDay, fmtNum, fmtTime } from "../lib/format";

type Tab = "now" | "schedule" | "history" | "forecast" | "reports";
interface Actuals { on_shift: { id: string; name: string; source: string; until: string | null }[]; staff: number; unacknowledged: number; needs_review: number; sla_at_risk: number; open_load: number; load_per_im: number | null; last_hour_volume: number; hourly_capacity: number; utilization_pct: number | null; required_now: number }
interface IntradayHour { hour: string; actual: number | null; forecast: number | null; lower: number | null; upper: number | null; staff: number; required: number; partial: boolean }
interface Intraday { hours: IntradayHour[]; gap_alerts: { hour: string; actual: number; expected: number; over_by: number; pct: number; staff: number; required: number }[]; has_forecast: boolean; method: string }
interface CoverageHour { hour: string; staff: number; people: { id: string; name: string; source: string }[]; forecast: number | null; required: number | null; short: boolean }
interface DayRow { date: string; volume: number; staff_hours: number; hours: number; covered_hours: number; required_hours: number; coverage_pct: number | null }
interface Gap { start: string; end: string; volume: number; staff: number; required: number; short_by: number }
interface History { total_volume: number; timezone: string; by_day: DayRow[]; by_hour_of_day: { hour: number; avg_volume: number; avg_staff: number }[]; heatmap: number[][]; gaps: Gap[] }
interface Accuracy { hours_scored: number; mape_pct: number | null; mae: number | null; bias: number | null; by_method: Record<string, number> }
interface Forecast {
  enabled: boolean; settings: { model: string; fallback: string; horizon_hours: number; minutes_per_alert: number; target_utilization: number };
  latest: { run_id: string; created_at: string; method: string; status: string; fallback_from: string; points: { ts: string; value: number; lower: number; upper: number }[] } | null;
  runs: { run_id: string; created_at: string; method: string; status: string; error: string; fallback_from: string; requested_by: string; points: number }[]; accuracy: Accuracy;
}
interface Rec { rec_id: string; kind: string; start: string; end: string; required: number; scheduled: number; gap: number; peak_forecast: number; suggested_person_id: string | null; suggested_person: string | null; rationale: string; status: string; decided_by: string | null; decided_at: string | null; decision_note: string }
interface Report { coverage_pct: number | null; utilization_pct: number | null; staff_hours: number; volume: number; alerts_per_staff_hour: number | null; unstaffed_hours_with_volume: number; accuracy: Accuracy; by_day: DayRow[]; gaps: Gap[]; assumptions: { minutes_per_alert: number; target_utilization: number; min_staff: number } }

const AXIS = { fontSize: 11, fill: "#80868b" };
const TIP = { borderRadius: 12, border: "none", background: "#1e1f20", color: "#e3e3e3", fontSize: 12 };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Math.round(v)}%`);
const toLocal = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

function VolumeChart({ rows }: { rows: { label: string; actual?: number | null; forecast?: number | null; band?: [number, number] | null; staff?: number; required?: number | null }[] }) {
  return (
    <div style={{ height: 300 }} role="img" aria-label="Alerts an hour against the forecast, with staffing">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
          <CartesianGrid vertical={false} stroke="rgb(128 134 139 / 0.2)" />
          <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} minTickGap={28} />
          <YAxis yAxisId="v" allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis yAxisId="s" orientation="right" allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
          <ChartTooltip contentStyle={TIP} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          <Area yAxisId="v" dataKey="band" name="Forecast range" stroke="none" fill="#9b72cb" fillOpacity={0.18} />
          <Bar yAxisId="v" dataKey="actual" name="Alerts" fill="#4285f4" radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Line yAxisId="v" dataKey="forecast" name="Forecast" stroke="#9b72cb" strokeWidth={2} dot={false} />
          <Line yAxisId="s" dataKey="staff" name="IMs scheduled" stroke="#34a853" strokeWidth={1.75} dot={false} type="stepAfter" />
          <Line yAxisId="s" dataKey="required" name="IMs needed" stroke="#ea4335" strokeWidth={1.75} strokeDasharray="4 3" dot={false} type="stepAfter" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function NowTab() {
  const a = useApi<Actuals>("/workforce/actuals", undefined, 30_000);
  const i = useApi<Intraday>("/workforce/intraday", { back: 12, ahead: 12 }, 60_000);
  const d = a.data;
  return (
    <div className="space-y-5">
      <ErrorState error={a.error || i.error} onRetry={() => { a.reload(); i.reload(); }} />
      {i.data?.gap_alerts.map((g) => (
        <Alert key={g.hour} tone="rose" title={`Volume is ${g.pct}% over the forecast for ${fmtTime(g.hour)}`}>{g.actual} alerts against {g.expected} expected. {g.required} IMs are needed at this pace, {g.staff} scheduled.</Alert>
      ))}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {!d ? Array.from({ length: 6 }).map((_, n) => <Skeleton key={n} className="h-[104px] rounded-2xl" />) : <>
          <Stat label="On shift" value={d.staff} hint={d.on_shift.map((p) => p.name).join(", ") || "no one"} tone={d.staff < d.required_now ? "rose" : undefined} glow={d.staff < d.required_now} />
          <Stat label="Needed now" value={d.required_now} hint="for the last hour's volume" />
          <Stat label="Open load" value={d.open_load} hint={`${d.unacknowledged} to acknowledge, ${d.needs_review} to review`} />
          <Stat label="Load per IM" value={d.load_per_im ?? "n/a"} hint="open alerts each" />
          <Stat label="Alerts last hour" value={d.last_hour_volume} hint={`capacity ${fmtNum(d.hourly_capacity)} an hour`} />
          <Stat label="Utilization" value={pct(d.utilization_pct)} hint="of planned alert time" tone={(d.utilization_pct ?? 0) > 100 ? "rose" : undefined} />
        </>}
      </div>
      <Card title="Today against the forecast" subtitle={i.data ? (i.data.has_forecast ? `Forecast by ${i.data.method}` : "No forecast yet: run one on the Forecast tab.") : undefined}>
        {i.data ? <VolumeChart rows={i.data.hours.map((h) => ({ label: fmtTime(h.hour), actual: h.actual, forecast: h.forecast, band: h.lower !== null && h.upper !== null ? [h.lower, h.upper] : null, staff: h.staff, required: h.required }))} /> : <Skeleton className="h-[300px]" />}
      </Card>
    </div>
  );
}

function ScheduleTab() {
  const [roster, setRoster] = useState("slrr_im");
  const c = useApi<{ hours: CoverageHour[]; timezone: string; shifts: { name: string; start: string; end: string; tz: string }[] }>("/workforce/coverage", { days: 7, roster });
  const byDay = new Map<string, CoverageHour[]>();
  for (const h of c.data?.hours ?? []) { const day = fmtDay(h.hour); byDay.set(day, [...(byDay.get(day) ?? []), h]); }
  return (
    <Card title="Coverage for the next 7 days" subtitle={c.data ? `Each cell is an hour (${c.data.timezone}): the number scheduled. Red is under what the forecast needs.` : undefined}
      actions={<>
        <Segmented label="Roster" value={roster} onChange={setRoster} options={[{ value: "slrr_im", label: "Incident Managers" }, { value: "burson", label: "Burson" }]} />
        <Link to="/rosters" className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white dark:bg-blue-200 dark:text-blue-900"><CalendarClock className="size-4" />Edit rosters and shifts</Link>
      </>}>
      <ErrorState error={c.error} onRetry={c.reload} />
      {!c.data ? <Skeleton className="h-56" /> : (
        <div className="scroll-thin overflow-x-auto">
          <table className="border-separate border-spacing-0.5 text-xs">
            <tbody>
              {[...byDay.entries()].map(([day, hours]) => (
                <tr key={day}>
                  <th scope="row" className="whitespace-nowrap pr-3 text-left font-normal text-zinc-500">{day}</th>
                  {hours.map((h) => (
                    <td key={h.hour} title={`${fmtDateTime(h.hour)}: ${h.people.map((p) => p.name).join(", ") || "no one"}${h.required !== null ? `. Needed: ${h.required}` : ""}`}
                      className={cx("size-7 rounded-md text-center tabular-nums", h.short ? "bg-rose-500/80 text-white" : h.staff === 0 ? "bg-zinc-200 text-zinc-500 dark:bg-zinc-800" : "bg-emerald-500/25 text-emerald-900 dark:text-emerald-100")}>{h.staff}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.data && <p className="mt-4 text-xs text-zinc-500">Shifts: {c.data.shifts.map((s) => `${s.name} ${s.start} to ${s.end} (${s.tz})`).join(", ") || "none set"}. Recurring patterns, swaps and overrides are edited on the Rosters page.</p>}
    </Card>
  );
}

function HistoryTab() {
  const [days, setDays] = useState(28);
  const h = useApi<History>("/workforce/historicals", { days });
  const max = Math.max(1, ...(h.data?.heatmap.flat() ?? [1]));
  return (
    <div className="space-y-5">
      <div className="flex justify-end"><Segmented label="Days" value={days} onChange={setDays} options={[7, 14, 28, 56].map((n) => ({ value: n, label: `${n} days` }))} /></div>
      <ErrorState error={h.error} onRetry={h.reload} />
      {!h.data ? <Skeleton className="h-72" /> : <>
        <Card title="Alerts and staffing by day" subtitle={`${fmtNum(h.data.total_volume)} alerts`}>
          <VolumeChart rows={h.data.by_day.map((d) => ({ label: d.date.slice(5), actual: d.volume, staff: d.staff_hours, required: d.required_hours }))} />
          <p className="mt-2 text-xs text-zinc-500">Right axis: staffed hours and needed hours a day.</p>
        </Card>
        <Card title="When alerts arrive" subtitle="Average alerts an hour, by weekday and hour">
          <div className="scroll-thin overflow-x-auto">
            <table className="border-separate border-spacing-0.5 text-xs"><tbody>
              {h.data.heatmap.map((row, d) => (
                <tr key={d}><th scope="row" className="pr-3 text-left font-normal text-zinc-500">{DAYS[d]}</th>
                  {row.map((v, hr) => <td key={hr} title={`${DAYS[d]} ${hr}:00: ${v.toFixed(1)} an hour`} className="size-7 rounded-md text-center tabular-nums text-zinc-900 dark:text-zinc-100" style={{ background: `rgb(66 133 244 / ${0.06 + 0.8 * (v / max)})` }}>{v >= 1 ? Math.round(v) : ""}</td>)}
                </tr>
              ))}
              <tr><td />{Array.from({ length: 24 }).map((_, hr) => <td key={hr} className="text-center text-zinc-500">{hr % 3 === 0 ? hr : ""}</td>)}</tr>
            </tbody></table>
          </div>
        </Card>
        <GapTable gaps={h.data.gaps} />
      </>}
    </div>
  );
}

function GapTable({ gaps }: { gaps: Gap[] }) {
  return (
    <Card title="Hours that were short" padded={false}>
      {gaps.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-500">No hour had fewer IMs than its volume needed.</p> : (
        <table className="w-full"><thead><tr><th className={TH}>From</th><th className={TH}>To</th><th className={TH}>Alerts</th><th className={TH}>Scheduled</th><th className={TH}>Needed</th></tr></thead>
          <tbody>{gaps.slice(0, 60).map((g) => <tr key={g.start} className={TR}><td className={TD}>{fmtDateTime(g.start)}</td><td className={TD}>{fmtTime(g.end)}</td><td className={cx(TD, "tabular-nums")}>{g.volume}</td><td className={cx(TD, "tabular-nums")}>{g.staff}</td><td className={cx(TD, "tabular-nums")}>{g.required}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function ForecastTab() {
  const { me, toast } = useApp();
  const f = useApi<Forecast>("/workforce/forecast");
  const [status, setStatus] = useState("pending");
  const recs = useApi<{ recommendations: Rec[]; people: { id: string; name: string }[] }>("/workforce/recommendations", { status });
  const [running, setRunning] = useState(false);
  const [edit, setEdit] = useState<Rec | null>(null);
  const [form, setForm] = useState({ person_id: "", start: "", end: "", note: "" });
  const [busy, setBusy] = useState("");
  const lead = !!me?.is_lead;
  const run = async () => {
    setRunning(true);
    try {
      const res = await apiSend<{ status: string; method?: string; recommendations?: number; error?: string }>("post", "/workforce/forecast/run");
      toast(res.status === "ok" ? `Forecast ready (${res.method}): ${res.recommendations ?? 0} recommendations` : res.error || "The forecast failed.", res.status === "ok" ? "success" : "error");
      f.reload(); recs.reload();
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setRunning(false); }
  };
  const decide = async (rec: Rec, decision: "accept" | "edit" | "dismiss", body: Record<string, unknown> = {}) => {
    setBusy(rec.rec_id + decision);
    try {
      await apiSend("post", `/workforce/recommendations/${rec.rec_id}`, { decision, ...body });
      toast(decision === "dismiss" ? "Dismissed" : "Added to the roster");
      setEdit(null); recs.reload();
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const latest = f.data?.latest;
  return (
    <div className="space-y-5">
      <ErrorState error={f.error || recs.error} onRetry={() => { f.reload(); recs.reload(); }} />
      {f.data && !f.data.enabled && <OffNotice what="The scheduled forecast" flag="workforce_forecasting">A lead can still run one by hand here.</OffNotice>}
      <Card title="Volume forecast" subtitle={latest ? `${latest.method}${latest.fallback_from ? ` (fell back from ${latest.fallback_from})` : ""}, made ${fmtDateTime(latest.created_at)}` : "No forecast has run yet."}
        actions={<Button variant="primary" icon={<Play className="size-4" />} disabled={!lead} loading={running} onClick={run}>Run forecast</Button>}>
        {latest?.points.length ? <VolumeChart rows={latest.points.map((p) => ({ label: fmtTime(p.ts), forecast: p.value, band: [p.lower, p.upper] }))} /> : <EmptyState icon={<UsersRound className="size-8" />} title="Nothing forecast yet">The forecast reads alert volume from BigQuery. Connect it in Settings, BigQuery, then run one.</EmptyState>}
        {f.data && <p className="mt-3 text-xs text-zinc-500">Staffing math: {f.data.settings.minutes_per_alert} minutes an alert at {Math.round(f.data.settings.target_utilization * 100)}% utilization. Accuracy over 14 days: MAPE {pct(f.data.accuracy.mape_pct)} across {f.data.accuracy.hours_scored} hours. <Link className="text-blue-600 dark:text-blue-200" to="/settings/forecasting">Change</Link></p>}
      </Card>
      <Card title="Recommendations" padded={false} subtitle="Nothing changes on the roster until a lead accepts."
        actions={<Segmented label="Status" value={status} onChange={setStatus} options={[{ value: "pending", label: "Pending" }, { value: "accepted", label: "Accepted" }, { value: "edited", label: "Edited" }, { value: "dismissed", label: "Dismissed" }]} />}>
        {!recs.data?.recommendations.length ? <p className="px-5 py-6 text-sm text-zinc-500">No {status} recommendations.</p> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {recs.data.recommendations.map((r) => (
              <li key={r.rec_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.kind === "add_coverage" ? "Add an IM" : r.kind.replace(/_/g, " ")}: {fmtDateTime(r.start)} to {fmtTime(r.end)}{r.suggested_person ? `, ${r.suggested_person}` : ""}</p>
                  <p className="text-xs text-zinc-500">{r.rationale}{r.decided_by ? ` Decided by ${r.decided_by}${r.decision_note ? `: ${r.decision_note}` : ""}.` : ""}</p>
                </div>
                <Badge tone="rose">short by {r.gap}</Badge>
                {r.status === "pending" && <>
                  <Button size="sm" variant="primary" disabled={!lead || !r.suggested_person_id} loading={busy === r.rec_id + "accept"} onClick={() => decide(r, "accept")}>Accept</Button>
                  <Button size="sm" disabled={!lead} onClick={() => { setEdit(r); setForm({ person_id: r.suggested_person_id ?? "", start: toLocal(r.start), end: toLocal(r.end), note: "" }); }}>Edit</Button>
                  <Button size="sm" disabled={!lead} loading={busy === r.rec_id + "dismiss"} onClick={() => decide(r, "dismiss")}>Dismiss</Button>
                </>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {f.data && f.data.runs.length > 0 && (
        <Card title="Runs" padded={false}>
          <table className="w-full"><thead><tr><th className={TH}>When</th><th className={TH}>Method</th><th className={TH}>Result</th><th className={TH}>By</th></tr></thead>
            <tbody>{f.data.runs.map((r) => <tr key={r.run_id} className={TR}><td className={TD}>{fmtDateTime(r.created_at)}</td><td className={TD}>{r.method}{r.fallback_from ? ` (after ${r.fallback_from})` : ""}</td><td className={TD}>{r.status === "ok" ? `${r.points} hours` : r.error}</td><td className={TD}>{r.requested_by}</td></tr>)}</tbody></table>
        </Card>
      )}
      <Modal open={!!edit} title="Edit the recommendation" onClose={() => setEdit(null)}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={!form.person_id || !form.start || !form.end} loading={!!edit && busy === edit.rec_id + "edit"}
          onClick={() => edit && decide(edit, "edit", { person_id: form.person_id, start: new Date(form.start).toISOString(), end: new Date(form.end).toISOString(), note: form.note })}>Add to the roster</Button></>}>
        <div className="space-y-3">
          <Field label="Who"><Select value={form.person_id} onChange={(e) => setForm({ ...form, person_id: e.target.value })}><option value="">Choose</option>{recs.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><Input type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
            <Field label="To"><Input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
          </div>
          <Field label="Note"><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}

function ReportsTab() {
  const [days, setDays] = useState(7);
  const r = useApi<Report>("/workforce/report", { days });
  const d = r.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Segmented label="Days" value={days} onChange={setDays} options={[7, 14, 28].map((n) => ({ value: n, label: `${n} days` }))} />
        <a href={`/api/workforce/report.csv?days=${days}`} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"><Download className="size-4" />Export CSV</a>
      </div>
      <ErrorState error={r.error} onRetry={r.reload} />
      {!d ? <Skeleton className="h-72" /> : <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Coverage" value={pct(d.coverage_pct)} hint="hours with enough IMs" tone={(d.coverage_pct ?? 100) < 90 ? "amber" : undefined} />
          <Stat label="Utilization" value={pct(d.utilization_pct)} hint="alert time over staffed time" />
          <Stat label="Forecast error" value={pct(d.accuracy.mape_pct)} hint={`MAPE over ${d.accuracy.hours_scored} hours`} />
          <Stat label="Alerts" value={fmtNum(d.volume)} hint={`${d.alerts_per_staff_hour ?? "n/a"} a staffed hour`} />
          <Stat label="Staffed hours" value={fmtNum(d.staff_hours)} />
          <Stat label="Unstaffed with alerts" value={d.unstaffed_hours_with_volume} hint="hours" tone={d.unstaffed_hours_with_volume ? "rose" : undefined} />
        </div>
        <Card title="By day" padded={false}>
          <table className="w-full"><thead><tr><th className={TH}>Day</th><th className={TH}>Alerts</th><th className={TH}>Staffed hours</th><th className={TH}>Needed hours</th><th className={TH}>Coverage</th></tr></thead>
            <tbody>{d.by_day.map((x) => <tr key={x.date} className={TR}><td className={TD}>{fmtDay(x.date)}</td><td className={cx(TD, "tabular-nums")}>{x.volume}</td><td className={cx(TD, "tabular-nums")}>{x.staff_hours}</td><td className={cx(TD, "tabular-nums")}>{x.required_hours}</td><td className={cx(TD, "tabular-nums")}>{pct(x.coverage_pct)}</td></tr>)}</tbody></table>
        </Card>
        <GapTable gaps={d.gaps} />
        <p className="text-xs text-zinc-500">Assumes {d.assumptions.minutes_per_alert} minutes an alert, {Math.round(d.assumptions.target_utilization * 100)}% utilization and at least {d.assumptions.min_staff} on shift.</p>
      </>}
    </div>
  );
}

export default function WorkforcePage() {
  const [search, setSearch] = useSearchParams();
  const tab = (search.get("tab") as Tab) || "now";
  return (
    <div>
      <PageHeader title="Workforce" />
      <Tabs<Tab> value={tab} onChange={(t) => setSearch(t === "now" ? {} : { tab: t }, { replace: true })}
        tabs={[{ key: "now", label: "Now" }, { key: "schedule", label: "Schedule" }, { key: "history", label: "History" }, { key: "forecast", label: "Forecast" }, { key: "reports", label: "Reports" }]} />
      {tab === "now" ? <NowTab /> : tab === "schedule" ? <ScheduleTab /> : tab === "history" ? <HistoryTab /> : tab === "forecast" ? <ForecastTab /> : <ReportsTab />}
    </div>
  );
}
