import { ChevronDown, ChevronRight, Mail, RefreshCw, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { useApi } from "../api/hooks";
import type { Escalation } from "../api/types";
import { CaseLink, TimeCell } from "../components/common";
import { EMAIL_STATUS_LABEL, EMAIL_STATUS_TONE, EscalationView, TNS_STATUS_LABEL, TNS_STATUS_TONE, triggerLabel } from "../components/EscalationView";
import { humanize } from "../lib/labels";
import { Badge, Button, Card, cx, EmptyState, ErrorState, Input, PageHeader, Pagination, Spinner, TD, TH, Toggle, TR } from "../components/ui";

const PAGE = 25;
const PURPOSE_SHORT: Record<string, string> = { alert: "Alert", tns_urgent: "T&S urgent", bug_followup: "Bug follow-up", group: "Group" };

export default function EscalationsPage() {
  const [search] = useSearchParams();
  const [openOnly, setOpenOnly] = useState(false);
  const [q, setQ] = useState(search.get("q") ?? "");
  const [expanded, setExpanded] = useState<string | null>(search.get("q"));
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi<{ escalations: Escalation[]; count: number; open: number }>("/escalations", { open_only: openOnly, limit: 2000 }, 60_000);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.escalations ?? []).filter((e) => !needle || [e.escalation_id, e.case_id, e.analyst_email, e.alert_name ?? "", e.tns?.bug_id ?? "", e.tns?.wd_issue_id ?? ""]
      .some((v) => v.toLowerCase().includes(needle)));
  }, [data, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));

  return (
    <div>
      <PageHeader title="Escalations" description="Social Alert email drafts in the IMs' Gmail with each version, and Trust & Safety reports with their outcomes."
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-zinc-400" />
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="ESC-1207, TRG-1042, IM email, bug id…" className="pl-8" aria-label="Search escalations" />
          </div>
          <Toggle checked={openOnly} onChange={(v) => { setOpenOnly(v); setPage(1); }} label="Open only (drafts not sent yet, T&S not finished)" />
          {data && <span className="text-sm text-zinc-500">{data.open} open of {data.count}</span>}
        </div>
      </Card>
      <ErrorState error={error} onRetry={reload} />
      <Card padded={false}>
        {loading && !data ? <Spinner /> : rows.length === 0 ? <EmptyState icon={<Mail className="size-8" />} title="No escalations match" /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px]">
                <thead><tr><th className={TH} /><th className={TH}>Escalation</th><th className={TH}>Case</th><th className={TH}>IM</th><th className={TH}>Emails</th><th className={TH}>T&S</th><th className={TH}>Requested</th></tr></thead>
                <tbody>
                  {rows.slice((page - 1) * PAGE, page * PAGE).map((e) => {
                    const isOpen = expanded === e.escalation_id;
                    return (
                      <Fragment key={e.escalation_id}>
                        <tr className={cx(TR, "cursor-pointer")} onClick={() => setExpanded(isOpen ? null : e.escalation_id)}>
                          <td className={cx(TD, "w-8")}>{isOpen ? <ChevronDown className="size-4 text-zinc-400" /> : <ChevronRight className="size-4 text-zinc-400" />}</td>
                          <td className={TD}>
                            <span className="font-mono text-xs font-semibold">{e.escalation_id}</span>
                            <div className="mt-1 flex gap-1"><Badge tone={e.is_open ? "violet" : "zinc"}>{e.is_open ? "Open" : "Done"}</Badge><Badge tone="zinc">{triggerLabel(e.trigger)}</Badge></div>
                          </td>
                          <td className={cx(TD, "max-w-[18rem]")} onClick={(ev) => ev.stopPropagation()}>
                            <CaseLink id={e.case_id} />
                            <p className="mt-1 truncate text-xs text-zinc-500" title={e.alert_name ?? ""}>{e.alert_name}</p>
                          </td>
                          <td className={cx(TD, "text-xs")}>{e.analyst_email}</td>
                          <td className={TD}>
                            <div className="flex flex-wrap gap-1">
                              {e.emails.length === 0 && <span className="text-xs text-zinc-400">—</span>}
                              {e.emails.map((m, i) => (
                                <Badge key={i} tone={EMAIL_STATUS_TONE[m.status] ?? "zinc"} title={m.error ?? undefined}>
                                  {PURPOSE_SHORT[m.purpose] ?? humanize(m.purpose)}: {(EMAIL_STATUS_LABEL[m.status] ?? humanize(m.status)).toLowerCase()}{m.versions.length > 1 ? ` · version ${m.versions.length}` : ""}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className={TD}>
                            {e.tns ? (
                              <div className="flex flex-wrap gap-1">
                                <Badge tone={TNS_STATUS_TONE[e.tns.status] ?? "zinc"}>{TNS_STATUS_LABEL[e.tns.status] ?? humanize(e.tns.status)}</Badge>
                                {e.tns.outcome && <Badge tone={e.tns.outcome === "Fixed" ? "emerald" : "zinc"}>{e.tns.outcome}</Badge>}
                                {e.tns.bug_id && <Badge tone="violet">b/{e.tns.bug_id}</Badge>}
                              </div>
                            ) : <span className="text-xs text-zinc-400">—</span>}
                          </td>
                          <td className={cx(TD, "text-xs")}><TimeCell value={e.requested_at} /></td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-zinc-100 dark:border-zinc-800">
                            <td colSpan={7} className="bg-zinc-50/70 px-6 py-4 dark:bg-zinc-900/40"><EscalationView esc={e} /></td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pages={pages} onPage={setPage} total={rows.length} />
          </>
        )}
      </Card>
    </div>
  );
}
