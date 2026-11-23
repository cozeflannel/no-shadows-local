import { FolderSearch, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { useApi } from "../api/hooks";
import type { CaseSummary } from "../api/types";
import { CaseDrawer } from "../components/CaseDrawer";
import { TimeCell } from "../components/common";
import { Badge, Button, Card, CaseBadges, cx, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";
import { fmtCompact, fmtDateTime } from "../lib/format";
import { SOURCE_LABEL, STATUS_LABEL, TRACK_LABEL } from "../lib/labels";

const PAGE = 30;

function SlaCell({ c }: { c: CaseSummary }) {
  if (!c.sla_due_at) return <span className="text-xs text-zinc-400">No SLA</span>;
  if (c.sla_met === true) return <Badge tone="emerald">Met</Badge>;
  if (c.sla_met === false) return <Badge tone="rose">Missed</Badge>;
  const due = new Date(c.sla_due_at).getTime();
  const open = c.status === "VERIFIED";
  if (!open) return <span className="text-xs text-zinc-400" title={fmtDateTime(c.sla_due_at)}>—</span>;
  return due < Date.now() ? <Badge tone="rose" title={fmtDateTime(c.sla_due_at)}>Overdue</Badge> : <Badge tone="violet" title={fmtDateTime(c.sla_due_at)}>Due <TimeCell value={c.sla_due_at} /></Badge>;
}

export default function CasesPage() {
  const { meta } = useApp();
  const { caseId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [status, setStatus] = useState(search.get("status") ?? "");
  const [source, setSource] = useState(search.get("source") ?? "");
  const [track, setTrack] = useState(search.get("track") ?? "");
  const [priority, setPriority] = useState("");
  const [days, setDays] = useState(search.get("days") ?? "14");
  const [q, setQ] = useState(search.get("q") ?? "");
  const [query, setQuery] = useState(q);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(q), 300);
    return () => window.clearTimeout(id);
  }, [q]);
  useEffect(() => setPage(1), [status, source, track, priority, days, query]);
  useEffect(() => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, source, track, days, q: query })) if (v) next.set(k, v);
    setSearch(next, { replace: true });
  }, [status, source, track, days, query, setSearch]);

  const { data, error, loading, reload } = useApi<{ cases: CaseSummary[]; total: number }>("/cases", {
    status: status || undefined, source: source || undefined, track: track || undefined, priority: priority || undefined,
    days: days === "all" ? undefined : Number(days), q: query || undefined, limit: 2000,
  }, 60_000);

  const rows = data?.cases ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const visible = useMemo(() => rows.slice((page - 1) * PAGE, page * PAGE), [rows, page]);
  const open = (id: string) => navigate({ pathname: `/cases/${id}`, search: search.toString() });

  return (
    <div>
      <PageHeader title="Cases" description="One case per alert. When Burson sends a fixed version it is added to the same case. Open a case for its versions, corrections, emails and timeline."
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>} />
      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Field label="Search" className="col-span-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-zinc-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="TRG-1042, product, tag, URL…" className="pl-8" />
            </div>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="VERIFIED,FAILED,NEEDS_REVIEW">Open (verified, waiting on Burson, needs review)</option>
              {(meta?.statuses ?? []).map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">All sources</option>
              {(meta?.sources ?? []).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] ?? s}</option>)}
            </Select>
          </Field>
          <Field label="Track and priority">
            <div className="flex gap-2">
              <Select value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Track">
                <option value="">Any track</option>
                {(meta?.tracks ?? []).map((t) => <option key={t} value={t}>{TRACK_LABEL[t] ?? t}</option>)}
                <option value="NONE">No track</option>
              </Select>
              <Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority" className="w-24">
                <option value="">Any</option>
                {(meta?.priorities ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </div>
          </Field>
          <Field label="Updated in">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              {["1", "7", "14", "30"].map((d) => <option key={d} value={d}>Last {d === "1" ? "24 hours" : `${d} days`}</option>)}
              <option value="all">All time</option>
            </Select>
          </Field>
        </div>
      </Card>
      <ErrorState error={error} onRetry={reload} />
      <Card padded={false}>
        {loading && !data ? <Spinner /> : rows.length === 0 ? (
          <EmptyState icon={<FolderSearch className="size-8" />} title="No cases match these filters" />
        ) : (
          <>
            <div className="scroll-thin max-h-[70vh] overflow-auto">
              <table className="w-full min-w-[1080px]">
                <thead>
                  <tr>
                    <th className={TH}>Case</th><th className={TH}>Status</th><th className={TH}>Alert</th>
                    <th className={TH}>Track</th><th className={TH}>Source</th><th className={cx(TH, "text-right")}>Engagement</th>
                    <th className={TH}>SLA</th><th className={TH}>Fixes</th><th className={TH}>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.case_id} onClick={() => open(c.case_id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(c.case_id)}
                      className={cx(TR, "cursor-pointer", caseId === c.case_id && "bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/40 dark:hover:bg-blue-900/60")}>
                      <td className={cx(TD, "whitespace-nowrap font-mono text-xs font-medium")}>{c.case_id}</td>
                      <td className={TD}><span className="flex flex-wrap gap-1"><CaseBadges status={c.status} verdict={c.verdict} /></span></td>
                      <td className={cx(TD, "max-w-[28rem]")}>
                        <p className="truncate font-medium" title={c.alert_name ?? ""}>{c.alert_name ?? "—"}</p>
                        <p className="truncate text-xs text-zinc-500">{[c.product, c.exposure_tag, c.platform].filter(Boolean).join(" · ")}</p>
                      </td>
                      <td className={TD}>
                        {c.track ? <Badge tone={c.track === "URGENT" ? "rose" : "blue"}>{TRACK_LABEL[c.track] ?? c.track}</Badge> : <span className="text-xs text-zinc-400">—</span>}
                        {c.priority && <span className="ml-1 font-mono text-xs text-zinc-500">{c.priority}</span>}
                      </td>
                      <td className={cx(TD, "whitespace-nowrap text-xs")}>{SOURCE_LABEL[c.source] ?? c.source}{c.counterpart_case_id && <span className="ml-1 text-blue-600 dark:text-blue-300" title={`The same post was also alerted as ${c.counterpart_case_id}`}>⇄</span>}</td>
                      <td className={cx(TD, "text-right font-mono text-xs")}>{fmtCompact(c.engagement_total)}{c.is_kof && <span className="ml-1" title="KOF">⭐</span>}</td>
                      <td className={TD}><SlaCell c={c} /></td>
                      <td className={cx(TD, "whitespace-nowrap text-xs")}>
                        {c.corrections > 0 && <Badge tone="blue" title="Fields the agent corrected">✏️ {c.corrections}</Badge>}
                        {c.proposed > 0 && <Badge tone="violet" className="ml-1" title="Corrections waiting for an IM">{c.proposed} to confirm</Badge>}
                        {c.escalation_ids.length > 0 && <Badge tone="zinc" className="ml-1" title="Emails started">📨 {c.escalation_ids.length}</Badge>}
                      </td>
                      <td className={cx(TD, "text-xs")}><TimeCell value={c.received_at} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pages={pages} onPage={setPage} total={data?.total} />
          </>
        )}
      </Card>
      <CaseDrawer caseId={caseId ?? null} onClose={() => navigate({ pathname: "/cases", search: search.toString() })} onChanged={reload} />
    </div>
  );
}
