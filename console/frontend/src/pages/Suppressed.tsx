import { EyeOff, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "../api/hooks";
import type { SuppressedResponse } from "../api/types";
import { BarList } from "../components/charts";
import { CaseLink, TimeCell } from "../components/common";
import { Badge, Button, Card, cx, EmptyState, ErrorState, PageHeader, Pagination, Segmented, Spinner, TD, TH, TR } from "../components/ui";
import { fmtCompact } from "../lib/format";
import { CHART_COLORS, SOURCE_LABEL, SUPPRESSION_LABEL } from "../lib/labels";

const PAGE = 30;

export default function SuppressedPage() {
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi<SuppressedResponse>("/suppressed", { days });
  const rows = useMemo(() => (data?.cases ?? []).filter((c) => !reason || c.reason === reason), [data, reason]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));

  return (
    <div>
      <PageHeader title="Suppressed" description="Alerts that didn't meet the Collection Requirements: logged with the reason, never posted. Spot-check them here."
        actions={<>
          <Segmented label="Window" value={days} onChange={(v) => { setDays(v); setPage(1); }} options={[1, 7, 14, 30].map((n) => ({ value: n, label: n === 1 ? "24 h" : `${n} d` }))} />
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>
        </>} />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card title="Reasons" subtitle={`${data.cases.length} suppressed · ${data.review_suppressed} by IM review`}>
            <BarList color={CHART_COLORS[9]} labelWidth={200} data={data.reasons.map((r) => ({ label: SUPPRESSION_LABEL[r.reason] ?? r.reason, value: r.count }))} valueLabel="Alerts" />
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => { setReason(null); setPage(1); }}><Badge tone={reason === null ? "blue" : "zinc"}>All</Badge></button>
              {data.reasons.map((r) => (
                <button type="button" key={r.reason} onClick={() => { setReason(r.reason); setPage(1); }}>
                  <Badge tone={reason === r.reason ? "blue" : "zinc"}>{SUPPRESSION_LABEL[r.reason] ?? r.reason} · {r.count}</Badge>
                </button>
              ))}
            </div>
          </Card>
          <Card className="xl:col-span-2" padded={false} title={reason ? SUPPRESSION_LABEL[reason] ?? reason : "All suppressed alerts"}>
            {rows.length === 0 ? <EmptyState icon={<EyeOff className="size-8" />} title="Nothing suppressed in this window" /> : (
              <>
                <div className="scroll-thin max-h-[65vh] overflow-auto">
                  <table className="w-full min-w-[760px]">
                    <thead><tr><th className={TH}>Case</th><th className={TH}>Alert</th><th className={TH}>Reason</th><th className={cx(TH, "text-right")}>Engagement</th><th className={TH}>Source</th><th className={TH}>Received</th></tr></thead>
                    <tbody>
                      {rows.slice((page - 1) * PAGE, page * PAGE).map((c) => (
                        <tr key={c.case_id} className={TR}>
                          <td className={TD}><CaseLink id={c.case_id} /></td>
                          <td className={cx(TD, "max-w-[22rem]")}>
                            <p className="truncate font-medium" title={c.alert_name ?? ""}>{c.alert_name}</p>
                            <p className="truncate text-xs text-zinc-500">{[c.exposure_tag, c.product].filter(Boolean).join(" · ")}</p>
                          </td>
                          <td className={TD}>
                            <Badge tone={c.reason.startsWith("EXCLUDED_") ? "violet" : c.reason === "im_review" ? "amber" : "zinc"}>{SUPPRESSION_LABEL[c.reason] ?? c.reason}</Badge>
                            {c.review_reason && <p className="mt-1 text-xs text-zinc-500">“{c.review_reason}” · {c.suppressed_by}</p>}
                            {c.reason_codes.length > 0 && <p className="mt-1 font-mono text-[11px] text-zinc-400">{c.reason_codes.join(", ")}</p>}
                          </td>
                          <td className={cx(TD, "text-right font-mono text-xs")}>{fmtCompact(c.engagement_total)}</td>
                          <td className={cx(TD, "text-xs")}>{SOURCE_LABEL[c.source] ?? c.source}</td>
                          <td className={cx(TD, "text-xs")}><TimeCell value={c.received_at} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pages={pages} onPage={setPage} total={rows.length} />
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
