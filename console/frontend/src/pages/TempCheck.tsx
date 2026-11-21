import { ArrowLeft, Copy, RefreshCw, Thermometer } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { SafeHtml } from "../components/SafeHtml";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, OffNotice, PageHeader, Segmented, Select, Spinner, Stat, TD, TH, TR, Textarea } from "../components/ui";
import { useApp } from "../context";
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative, fmtTime } from "../lib/format";

interface Brief { check_id: string; issue: string; status: string; total: number; concern_level: string; basis: string; trigger: string; via: string; requested_by: string; case_id: string | null; created_at: string; update_of: string | null; title: string; error: string; actions: { actor: string; action: string; at: string; note: string }[] }
interface Check extends Brief {
  hours: { at: string; n: number }[]; start: { at?: string; why?: string }; velocity: { peak: { at: string; n: number }; last: { at: string; n: number }; pct: number } | null;
  sentiment: Record<string, number>; sources: { label: string; n: number }[]; posts: { source: string; author: string; text: string; url: string; eng: number | null; negative: boolean; at: string | null }[];
  level: { label?: string; why?: string; n?: number }; writeup_text: string; writeup_html: string; notes: string[]; reasons: string[];
  query: { name?: string; boolean?: string; drafted?: boolean; draft_why?: string; relevance?: { about: number; other: number } }; window_from: string | null; window_to: string | null;
  doc_url: string;
}
interface ListResponse {
  checks: Brief[]; enabled: boolean; auto_enabled: boolean;
  setup: { brandwatch: boolean; sources: { key: string; label: string; enabled: boolean }[]; standing_queries: number; lookback_hours: number };
  auto: { started_today: number; daily_limit: number };
}
interface Conversion { ok: boolean; error: string; plan: string; report: { converted?: number; left_out?: string[] } }

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
  return (
    <div className="space-y-4">
      <Link to="/temp-check" className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-200"><ArrowLeft className="size-4" />All temp checks</Link>
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
          <Button icon={<RefreshCw className="size-4" />} disabled={!canAct} loading={busy === "refresh"} onClick={refresh}>Run again</Button>
          <Button variant="primary" disabled={!canAct || c.status !== "complete"} loading={busy === "used"} onClick={() => act("used")}>Mark as used</Button>
          <Button disabled={!canAct} loading={busy === "dismissed"} onClick={() => act("dismissed")}>Dismiss</Button>
        </div>
      </div>
      {c.status === "failed" && <Alert tone="rose" title="This temp check failed">{c.error}</Alert>}
      {c.status === "query_not_confirmed" && <Alert tone="amber" title="The drafted query mostly finds other posts, so no count is given">
        {c.query.relevance ? `${c.query.relevance.about} of the sampled posts were about this issue, ${c.query.relevance.other} were not. ` : ""}Edit the Boolean below and run it again.
      </Alert>}
      {c.notes.map((n) => <Alert key={n} tone="blue">{n}</Alert>)}
      {c.status === "running" && <Spinner label="Counting posts…" />}
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

export default function TempCheckPage() {
  const { me, toast } = useApp();
  const { checkId } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const list = useApi<ListResponse>("/temp-checks", undefined, 30_000);
  const [mode, setMode] = useState<"boolean" | "saved" | "draft">("boolean");
  const [issue, setIssue] = useState(search.get("issue") ?? "");
  const [boolean, setBoolean] = useState("");
  const [queryRef, setQueryRef] = useState("");
  const [hours, setHours] = useState("");
  const [keep, setKeep] = useState("");
  const [conv, setConv] = useState<Conversion | null>(null);
  const [running, setRunning] = useState(false);
  const queries = useApi<{ queries: { id: number | string; name: string }[]; error: string }>(mode === "saved" && list.data?.setup.brandwatch ? "/temp-checks/queries" : null);
  const caseId = search.get("case") ?? undefined;
  const canAct = !!me?.can_act;

  useEffect(() => {
    if (mode !== "boolean" || !boolean.trim()) { setConv(null); return; }
    const t = window.setTimeout(() => { apiSend<Conversion>("post", "/temp-checks/convert", { boolean }).then(setConv).catch(() => setConv(null)); }, 500);
    return () => window.clearTimeout(t);
  }, [boolean, mode]);

  if (checkId) return <CheckView key={checkId} id={checkId} canAct={canAct} />;

  const run = async () => {
    setRunning(true);
    try {
      const res = await apiSend<{ check_id?: string; check?: Brief; data?: { user_error?: string } }>("post", "/temp-checks", {
        issue, case_id: caseId, hours: hours ? Number(hours) : undefined, keep_refreshed_hours: keep ? Number(keep) : 0,
        boolean: mode === "boolean" ? boolean : "", query_ref: mode === "saved" ? queryRef : "", draft_query: mode === "draft" });
      const id = res.check?.check_id ?? res.check_id;
      if (id) navigate(`/temp-check/${id}`); else toast(res.data?.user_error ?? "The temp check did not start.", "error");
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setRunning(false); }
  };
  const s = list.data?.setup;
  const ready = mode === "boolean" ? !!boolean.trim() && conv?.ok !== false : mode === "saved" ? !!queryRef : !!issue.trim();
  return (
    <div>
      <PageHeader title="Temp check" />
      <ErrorState error={list.error} onRetry={list.reload} />
      {list.data && !list.data.enabled && <OffNotice what="Temp check" flag="temp_checks" />}
      {s && !s.brandwatch && s.sources.filter((x) => x.enabled).length === 0 && (
        <Alert tone="amber" className="mb-4" title="Nothing to count from yet">Add the Brandwatch project and token, or a table of posts, in <Link className="font-medium underline" to="/settings/temp_check">Settings, Temp check</Link>.</Alert>
      )}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <Card className="h-fit xl:col-span-2" title="Run one">
          <div className="space-y-4">
            <Field label="Issue"><Input value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Gmail calendar invite scam" disabled={!canAct} /></Field>
            <Segmented label="Query" value={mode} onChange={setMode} options={[{ value: "boolean", label: "Boolean" }, { value: "saved", label: "Saved query" }, { value: "draft", label: "Draft it for me" }]} />
            {mode === "boolean" && <>
              <Field label="Brandwatch Boolean" error={conv && !conv.ok ? conv.error : null}>
                <Textarea rows={6} value={boolean} onChange={(e) => setBoolean(e.target.value)} disabled={!canAct} placeholder={'("calendar invite" OR gmail) AND (scam* OR phishing)'} />
              </Field>
              {conv?.ok && <p className="text-xs text-zinc-500">{conv.report.converted} terms understood.{conv.report.left_out?.length ? ` Left out: ${conv.report.left_out.join("; ")}` : ""}</p>}
            </>}
            {mode === "saved" && (
              <Field label="Saved Brandwatch query" error={queries.data?.error || (s && !s.brandwatch ? "Brandwatch is not set up." : null)}>
                <Select value={queryRef} onChange={(e) => setQueryRef(e.target.value)} disabled={!canAct}><option value="">Choose a query</option>{(queries.data?.queries ?? []).map((q) => <option key={q.id} value={String(q.id)}>{q.name}</option>)}</Select>
              </Field>
            )}
            {mode === "draft" && <p className="text-sm text-zinc-500">The agent writes a query from the issue{caseId ? ` and ${caseId}` : ""}, checks a sample of what it finds, and gives no count if the sample is mostly other posts.</p>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Look back (hours)" hint={s ? `Empty: ${s.lookback_hours} hours.` : undefined}><Input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} disabled={!canAct} /></Field>
              <Field label="Keep refreshed (hours)" hint="Empty: run once."><Input type="number" min={0} max={72} value={keep} onChange={(e) => setKeep(e.target.value)} disabled={!canAct} /></Field>
            </div>
            <Button variant="primary" icon={<Thermometer className="size-4" />} disabled={!canAct || !ready || !list.data?.enabled} loading={running} onClick={run}>Run temp check</Button>
          </div>
        </Card>
        <Card className="xl:col-span-3" padded={false} title="Recent"
          subtitle={list.data ? (list.data.auto_enabled ? `Automatic runs: ${list.data.auto.started_today} of ${list.data.auto.daily_limit} today` : "Automatic runs are switched off") : undefined}>
          {list.loading && !list.data ? <Spinner /> : !list.data?.checks.length ? <EmptyState icon={<Thermometer className="size-8" />} title="No temp checks yet">Run one here, or say "temp check" to the agent in Chat.</EmptyState> : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.data.checks.map((c) => (
                <li key={c.check_id}>
                  <Link to={`/temp-check/${c.check_id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.issue || c.title || c.check_id}</span>
                      <span className="text-xs text-zinc-500">{fmtRelative(c.created_at)} by {c.requested_by}{c.trigger && c.trigger !== "manual" ? `, ${c.trigger}` : ""}{c.case_id ? `, ${c.case_id}` : ""}</span>
                    </span>
                    <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-300">{c.status === "complete" ? fmtCompact(c.total) : ""}</span>
                    {c.concern_level && <Badge tone={LEVEL_TONE[c.concern_level] ?? "zinc"}>{c.concern_level}</Badge>}
                    <Badge tone={STATUS_TONE[c.status] ?? "zinc"}>{c.status.replace(/_/g, " ")}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
