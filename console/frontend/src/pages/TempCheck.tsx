import { Copy, RefreshCw, Thermometer } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { SafeHtml } from "../components/SafeHtml";
import { TempCheckForm, type FormInfo } from "../components/TempCheckForm";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, OffNotice, PageHeader, Spinner, Stat, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative, fmtTime } from "../lib/format";

interface Brief { own_posts: number; own_from: string | null; standing: boolean; check_id: string; issue: string; status: string; total: number; concern_level: string; basis: string; trigger: string; via: string; requested_by: string; case_id: string | null; created_at: string; update_of: string | null; title: string; error: string; actions: { actor: string; action: string; at: string; note: string }[] }
interface Check extends Brief {
  hours: { at: string; n: number }[]; start: { at?: string; why?: string }; velocity: { peak: { at: string; n: number }; last: { at: string; n: number }; pct: number } | null;
  sentiment: Record<string, number>; sources: { label: string; n: number }[]; posts: { source: string; author: string; text: string; url: string; eng: number | null; negative: boolean; at: string | null }[];
  level: { label?: string; why?: string; n?: number }; writeup_text: string; writeup_html: string; notes: string[]; reasons: string[];
  query: { name?: string; boolean?: string; drafted?: boolean; draft_why?: string; relevance?: { about: number; other: number } }; window_from: string | null; window_to: string | null;
  doc_url: string; steps: { at: string; text: string }[]; keep_refreshed_until: string | null;
}
interface ListResponse {
  checks: Brief[]; enabled: boolean; auto_enabled: boolean;
  setup: { brandwatch: boolean; sources: { key: string; label: string; enabled: boolean }[]; standing_queries: number; lookback_hours: number };
  form: FormInfo;
  auto: { started_today: number; daily_limit: number };
}

const STATUS_TONE: Record<string, "emerald" | "rose" | "amber" | "blue" | "zinc"> = { complete: "emerald", failed: "rose", query_not_confirmed: "amber", running: "blue", empty: "zinc" };
const LEVEL_TONE: Record<string, "rose" | "amber" | "emerald" | "zinc"> = { HIGH: "rose", "MODERATELY HIGH": "rose", MODERATE: "amber", "MODERATELY LOW": "emerald", LOW: "emerald" };

function CheckView({ id, canAct }: { id: string; canAct: boolean }) {
  const { toast } = useApp();
  const navigate = useNavigate();
  const { data, error, loading, reload, setData } = useApi<{ check: Check; related: Brief[] }>(`/temp-checks/${id}`);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (data?.check.status !== "running") return;
    const t = window.setInterval(reload, 4000);
    return () => window.clearInterval(t);
  }, [data?.check.status, reload]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const c = data.check;
  const act = async (action: string) => {
    setBusy(action);
    try {
      const res = await apiSend<{ check: Check }>("post", `/temp-checks/${id}/action`, { action });
      setData({ ...data, check: res.check });
      toast("Recorded");
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const refresh = async () => {
    setBusy("refresh");
    try {
      const res = await apiSend<{ check_id?: string; check?: Check }>("post", "/temp-checks", { issue: c.issue, update_of: c.check_id, case_id: c.case_id });
      const next = res.check?.check_id ?? res.check_id;
      if (next) navigate(`/temp-check/${next}`);
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const sentTotal = Object.values(c.sentiment).reduce((a, b) => a + b, 0);
  const keeping = !!c.keep_refreshed_until && new Date(c.keep_refreshed_until).getTime() > Date.now();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[1.75rem] font-medium leading-tight tracking-tight">{c.issue || c.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <Badge tone={STATUS_TONE[c.status] ?? "zinc"}>{c.status.replace(/_/g, " ")}</Badge>{c.check_id}<span>{fmtDateTime(c.created_at)}</span><span>by {c.requested_by}</span>
            <span>{c.basis === "own" ? "from our own tables" : c.basis === "brandwatch" ? "from Brandwatch" : c.basis}</span>
            {c.case_id && <Link to={`/feed/${c.case_id}`} className="text-blue-600 dark:text-blue-200">{c.case_id}</Link>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.doc_url && <a href={c.doc_url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">Open the document</a>}
          <Button icon={<Copy className="size-4" />} disabled={!c.writeup_text} onClick={() => { void navigator.clipboard.writeText(c.writeup_text); toast("Copied"); }}>Copy write-up</Button>
          <Button icon={<RefreshCw className="size-4" />} disabled={!canAct} loading={busy === "refresh"} onClick={refresh}>Refresh (send as an update)</Button>
          {keeping
            ? <Button disabled={!canAct} loading={busy === "stop_refresh"} onClick={() => act("stop_refresh")} title={`Refreshed every hour until ${fmtDateTime(c.keep_refreshed_until)}`}>Stop refreshing</Button>
            : <Button disabled={!canAct || c.status === "running"} loading={busy === "keep_refreshed"} onClick={() => act("keep_refreshed")}
                title="A refresh every hour for the next day, whether or not automatic temp checks are on">Keep refreshed for a day</Button>}
          <Button variant="primary" disabled={!canAct || c.status !== "complete"} loading={busy === "used"} onClick={() => act("used")}>Mark as used</Button>
          <Button disabled={!canAct} loading={busy === "dismissed"} onClick={() => act("dismissed")}>Dismiss</Button>
        </div>
      </div>
      {c.status === "failed" && <Alert tone="rose" title="This temp check failed">{c.error}</Alert>}
      {c.status === "query_not_confirmed" && <Alert tone="amber" title="The drafted query mostly finds other posts, so no count is given">
        {c.query.relevance ? `${c.query.relevance.about} of the sampled posts were about this issue, ${c.query.relevance.other} were not. ` : ""}Edit the Boolean below and run it again.
      </Alert>}
      {c.notes.map((n) => <Alert key={n} tone="blue">{n}</Alert>)}
      {c.status === "running" && (c.steps.length
        ? <ol className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">{c.steps.map((st, i) => <li key={i} className={i === c.steps.length - 1 ? "text-blue-600 dark:text-blue-300" : ""}>{st.text}</li>)}</ol>
        : <Spinner label="Starting…" />)}
      {(c.status === "complete" || c.status === "empty") && <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Matching posts" value={fmtCompact(c.total)} hint={c.start.at ? `since ${fmtDateTime(c.start.at)}` : ""} />
          <Stat label="Concern level" value={<span className="text-xl">{c.concern_level || "Not rated"}</span>} hint={c.level.why ?? (c.level.n ? `against ${c.level.n} past issues` : "")} tone={LEVEL_TONE[c.concern_level] === "rose" ? "rose" : LEVEL_TONE[c.concern_level] === "amber" ? "amber" : undefined} glow={LEVEL_TONE[c.concern_level] === "rose"} />
          <Stat label="Velocity since peak" value={c.velocity ? `${c.velocity.pct > 0 ? "+" : ""}${c.velocity.pct}%` : "n/a"} hint={c.velocity ? `peak ${fmtNum(c.velocity.peak.n)} at ${fmtTime(c.velocity.peak.at)}` : ""} />
          <Stat label="Negative" value={sentTotal ? `${Math.round(((c.sentiment.negative ?? 0) / sentTotal) * 100)}%` : "n/a"} hint={sentTotal ? `${fmtNum(c.sentiment.negative ?? 0)} of ${fmtNum(sentTotal)} rated` : ""} />
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
          <Card className="xl:col-span-3" title="Write-up">
            {c.writeup_html ? <SafeHtml html={c.writeup_html} className="prose-plain text-zinc-800 dark:text-zinc-200" /> : <p className="text-sm text-zinc-500">No write-up.</p>}
          </Card>
          <div className="space-y-4 xl:col-span-2">
            <Card title="Posts an hour">
              <div style={{ height: 200 }} role="img" aria-label="Posts an hour">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={c.hours.map((h) => ({ at: fmtTime(h.at), n: h.n }))} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                    <CartesianGrid vertical={false} stroke="rgb(128 134 139 / 0.2)" />
                    <XAxis dataKey="at" tick={{ fontSize: 11, fill: "#80868b" }} axisLine={false} tickLine={false} minTickGap={28} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#80868b" }} axisLine={false} tickLine={false} />
                    <ChartTooltip cursor={{ fill: "rgb(128 134 139 / 0.12)" }} contentStyle={{ borderRadius: 12, border: "none", background: "#1e1f20", color: "#e3e3e3", fontSize: 12 }} />
                    <Bar dataKey="n" name="Posts" fill="#4285f4" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Where">
              <ul className="space-y-1.5 text-sm">{c.sources.slice(0, 8).map((s) => <li key={s.label} className="flex justify-between gap-3"><span>{s.label}</span><span className="tabular-nums text-zinc-500">{fmtNum(s.n)}</span></li>)}</ul>
            </Card>
          </div>
        </div>
        <Card title="Posts" padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full"><thead><tr><th className={TH}>Post</th><th className={TH}>Where</th><th className={TH}>Engagement</th><th className={TH}>Posted</th></tr></thead>
              <tbody>{c.posts.map((p, i) => (
                <tr key={i} className={TR}>
                  <td className={cx(TD, "max-w-xl")}><a href={p.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-blue-600 hover:underline dark:text-blue-200">{p.text || p.url}</a><span className="text-xs text-zinc-500">{p.author}{p.negative ? ", negative" : ""}</span></td>
                  <td className={TD}>{p.source}</td><td className={cx(TD, "tabular-nums")}>{fmtCompact(p.eng)}</td><td className={TD}>{p.at ? fmtRelative(p.at) : ""}</td>
                </tr>))}</tbody></table>
          </div>
        </Card>
      </>}
      {c.query.boolean && <Card title={c.query.drafted ? "Query (drafted by the agent)" : "Query"} subtitle={c.query.draft_why}><pre className="scroll-thin overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{c.query.boolean}</pre></Card>}
      {(c.actions.length > 0 || data.related.length > 1) && (
        <Card title="History">
          <ul className="space-y-1 text-xs text-zinc-500">
            {data.related.filter((r) => r.check_id !== c.check_id).map((r) => <li key={r.check_id}><Link className="text-blue-600 dark:text-blue-200" to={`/temp-check/${r.check_id}`}>{r.check_id}</Link> {fmtDateTime(r.created_at)}: {fmtNum(r.total)} posts {r.concern_level}</li>)}
            {c.actions.map((a, i) => <li key={i}>{fmtDateTime(a.at)}: {a.action} by {a.actor}{a.note ? ` (${a.note})` : ""}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** One past temp check as a line: when, what was counted, its level, and how it came about. */
function pastLine(c: Brief): string {
  const counted = c.status === "complete" || c.status === "empty" ? `${fmtNum(c.total)} ${c.basis === "own" ? "posts (our data)" : "mentions"}` : "";
  return [fmtDateTime(c.created_at), counted, c.concern_level, c.trigger === "alert" ? "from an alert" : "", c.update_of ? "update" : ""].filter(Boolean).join(" · ");
}

export default function TempCheckPage() {
  const { me } = useApp();
  const { checkId } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const list = useApi<ListResponse>("/temp-checks", undefined, 30_000);
  const canAct = !!me?.can_act;
  const s = list.data?.setup;
  const checks = list.data?.checks ?? [];
  return (
    <div>
      <PageHeader title="Temp check" />
      <ErrorState error={list.error} onRetry={list.reload} />
      {list.data && !list.data.enabled && <OffNotice what="Temp check" flag="temp_checks" />}
      {s && !s.brandwatch && s.sources.filter((x) => x.enabled).length === 0 && (
        <Alert tone="amber" className="mb-4" title="Nothing to count from yet">Add the Brandwatch project and token, or a table of posts, in <Link className="font-medium underline" to="/settings/temp_check">Settings, Temp check</Link>.</Alert>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
        <div className={cx("min-w-0 space-y-5", checkId && "order-last lg:order-none")}>
          <TempCheckForm info={list.data?.form} past={checks} canAct={canAct} enabled={!!list.data?.enabled} brandwatch={!!s?.brandwatch}
            caseId={search.get("case") ?? undefined} initialIssue={search.get("issue") ?? undefined}
            onDone={(id) => { list.reload(); navigate(`/temp-check/${id}`); }} />
          <Card padded={false} title="Past temp checks"
            subtitle={list.data ? (list.data.auto_enabled ? `Automatic: ${list.data.auto.started_today} of ${list.data.auto.daily_limit} started today` : "Nothing starts by itself: automatic temp checks are OFF") : undefined}>
            {list.loading && !list.data ? <Spinner /> : !checks.length ? <p className="px-5 pb-5 text-sm text-zinc-500">None yet.</p> : (
              <ul className="scroll-thin max-h-[28rem] divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
                {checks.map((c) => (
                  <li key={c.check_id}>
                    <Link to={`/temp-check/${c.check_id}`} aria-current={c.check_id === checkId ? "page" : undefined}
                      className={cx("block px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40", c.check_id === checkId && "bg-blue-50 dark:bg-blue-500/10")}>
                      <span className="flex items-start justify-between gap-2">
                        <span className="min-w-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.title || c.issue || c.check_id}</span>
                        {c.status !== "complete" && <Badge tone={STATUS_TONE[c.status] ?? "zinc"} className="shrink-0">{c.status === "empty" ? "nothing matched" : c.status.replace(/_/g, " ")}</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">{pastLine(c)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="min-w-0">
          {checkId ? <CheckView key={checkId} id={checkId} canAct={canAct} /> : (
            <Card><EmptyState icon={<Thermometer className="size-8" />} title="No temp check open">Run one, or open a past one.</EmptyState></Card>
          )}
        </div>
      </div>
    </div>
  );
}
