import { Thermometer } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { TempCheckForm, type FormInfo } from "../components/TempCheckForm";
import type { TcCheck } from "../components/TempCheckResult";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, OffNotice, PageHeader, Spinner } from "../components/ui";
import { useApp } from "../context";
import { fmtDateTime, fmtNum } from "../lib/format";
import { humanize } from "../lib/labels";

// The result tabs carry the charts, so they load when a temp check is opened, not with the Console.
const TempCheckResult = lazy(() => import("../components/TempCheckResult").then((m) => ({ default: m.TempCheckResult })));

interface Brief { own_posts: number; own_from: string | null; standing: boolean; check_id: string; issue: string; status: string; total: number; concern_level: string; basis: string; trigger: string; via: string; requested_by: string; case_id: string | null; created_at: string; update_of: string | null; title: string; error: string; actions: { actor: string; action: string; at: string; note: string }[] }
type Check = Brief & TcCheck & { reasons: string[]; doc_url: string; steps: { at: string; text: string }[] };
interface ListResponse {
  checks: Brief[]; enabled: boolean; auto_enabled: boolean; web_enabled: boolean;
  setup: { brandwatch: boolean; sources: { key: string; label: string; enabled: boolean }[]; lookback_hours: number };
  form: FormInfo;
  auto: { started_today: number; daily_limit: number };
}

const STATUS_TONE: Record<string, "emerald" | "rose" | "violet" | "blue" | "zinc"> = { complete: "emerald", failed: "rose", query_not_confirmed: "violet", running: "blue", empty: "zinc" };
const STATUS_LABEL: Record<string, string> = { complete: "Done", failed: "Failed", query_not_confirmed: "Query needs work", running: "Running", empty: "Nothing matched" };
const LEVEL_TONE: Record<string, "rose" | "violet" | "emerald" | "zinc"> = { HIGH: "rose", "MODERATELY HIGH": "rose", MODERATE: "violet", "MODERATELY LOW": "emerald", LOW: "emerald" };
const statusLabel = (s: string) => STATUS_LABEL[s] ?? humanize(s);

function CheckView({ id, canAct, web, tables }: { id: string; canAct: boolean; web: boolean; tables: FormInfo["tables"] }) {
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
  const counted = c.status === "complete" || c.status === "empty";
  const rel = c.query.relevance;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] font-medium leading-tight tracking-tight">{c.issue || c.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <Badge tone={STATUS_TONE[c.status] ?? "zinc"}>{statusLabel(c.status)}</Badge>{c.check_id}<span>by {c.requested_by}</span>
            <span>{c.basis === "own" ? "from our own tables" : c.basis === "brandwatch" ? (c.standing ? "from Brandwatch's standing queries" : "from Brandwatch") : c.basis}</span>
            {c.concern_level && <Badge tone={LEVEL_TONE[c.concern_level.toUpperCase()] ?? "zinc"}>{c.concern_level}</Badge>}
            {c.case_id && <Link to={`/feed/${c.case_id}`} className="text-blue-600 dark:text-blue-200">{c.case_id}</Link>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.doc_url && <a href={c.doc_url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">Open the document</a>}
          <Button variant="primary" disabled={!canAct || c.status !== "complete"} loading={busy === "used"} onClick={() => act("used")}>Mark as used</Button>
          <Button disabled={!canAct} loading={busy === "dismissed"} onClick={() => act("dismissed")}>Dismiss</Button>
        </div>
      </div>
      {c.status === "failed" && <Alert tone="rose" title="This temp check failed">{c.error}</Alert>}
      {c.status === "query_not_confirmed" && <Alert tone="violet" title="The drafted query mostly finds other posts, so no count is given">
        {rel ? `${rel.about} of the ${rel.read} posts read were about this issue. ` : ""}Edit the query below and run it again.
      </Alert>}
      {!counted && c.notes.map((n) => <Alert key={n} tone="blue">{n}</Alert>)}
      {c.status === "running" && (c.steps.length
        ? <ol className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">{c.steps.map((st, i) => <li key={i} className={i === c.steps.length - 1 ? "text-blue-600 dark:text-blue-300" : ""}>{st.text}</li>)}</ol>
        : <Spinner label="Starting…" />)}
      {counted && <Suspense fallback={<Spinner />}><TempCheckResult c={c} tables={tables} canAct={canAct} web={web} busy={busy} onRefresh={refresh} onKeep={act} toast={toast} /></Suspense>}
      {!counted && c.query.boolean && <Card title={c.query.drafted ? "Query (drafted by the agent)" : "Query"} subtitle={c.query.draft_why}><pre className="scroll-thin overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{c.query.boolean}</pre></Card>}
      {(c.actions.length > 0 || data.related.length > 1) && (
        <Card title="History">
          <ul className="space-y-1 text-xs text-zinc-500">
            {data.related.filter((r) => r.check_id !== c.check_id).map((r) => <li key={r.check_id}><Link className="text-blue-600 dark:text-blue-200" to={`/temp-check/${r.check_id}`}>{r.check_id}</Link> {fmtDateTime(r.created_at)}: {fmtNum(r.total)} {r.basis === "own" ? "posts" : "mentions"} {r.concern_level}</li>)}
            {c.actions.map((a, i) => <li key={i}>{fmtDateTime(a.at)}: {humanize(a.action)} by {a.actor}{a.note ? ` (${a.note})` : ""}</li>)}
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
        <Alert tone="violet" className="mb-4" title="Nothing to count from yet">Add the Brandwatch project and token, or a table of posts, in <Link className="font-medium underline" to="/settings/temp_check">Settings, Temp check</Link>.</Alert>
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
                        {c.status !== "complete" && <Badge tone={STATUS_TONE[c.status] ?? "zinc"} className="shrink-0">{statusLabel(c.status)}</Badge>}
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
          {checkId ? <CheckView key={checkId} id={checkId} canAct={canAct} web={!!list.data?.web_enabled} tables={list.data?.form.tables ?? []} /> : (
            <Card><EmptyState icon={<Thermometer className="size-8" />} title="No temp check open">Run one, or open a past one.</EmptyState></Card>
          )}
        </div>
      </div>
    </div>
  );
}
