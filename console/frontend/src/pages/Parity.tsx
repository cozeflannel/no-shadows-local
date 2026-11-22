import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { useApi } from "../api/hooks";
import type { CaseSummary, ParityResponse } from "../api/types";
import { BarList } from "../components/charts";
import { CaseLink, TimeCell } from "../components/common";
import { Badge, Button, Card, cx, EmptyState, ErrorState, PageHeader, Segmented, Spinner, StatusBadge, Tabs, TD, TH, TR, Tooltip } from "../components/ui";
import { useApp } from "../context";
import { fmtPct, fmtValue } from "../lib/format";
import { CHART_COLORS, TRACK_LABEL } from "../lib/labels";

type Tab = "matched" | "burson_only" | "inhouse_only" | "pending";

function Stat({ label, value, help, tone }: { label: string; value: string | number; help: string; tone?: string }) {
  return (
    <Tooltip content={help} className="block">
      <div className="w-full cursor-help rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-xs font-medium text-zinc-500">{label}</p>
        <p className={cx("mt-1 font-mono text-2xl font-semibold", tone ?? "text-zinc-950 dark:text-zinc-50")}>{value}</p>
      </div>
    </Tooltip>
  );
}

function CaseCell({ c }: { c: CaseSummary | null }) {
  if (!c) return <span className="text-zinc-400">—</span>;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5"><CaseLink id={c.case_id} />{c.status && <StatusBadge status={c.status} />}</div>
      <p className="mt-1 truncate text-xs text-zinc-500" title={c.alert_name ?? ""}>{c.alert_name}</p>
    </div>
  );
}

function UnmatchedTable({ rows, empty }: { rows: { case: CaseSummary; at?: string }[]; empty: string }) {
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <div className="scroll-thin max-h-[60vh] overflow-auto">
      <table className="w-full min-w-[720px]">
        <thead><tr><th className={TH}>Case</th><th className={TH}>Track</th><th className={TH}>Exposure tag</th><th className={TH}>Received</th><th className={TH}>Compared on</th></tr></thead>
        <tbody>
          {rows.map(({ case: c, at }) => (
            <tr key={c.case_id} className={TR}>
              <td className={cx(TD, "max-w-[24rem]")}><CaseCell c={c} /></td>
              <td className={TD}>{c.track ? <Badge tone={c.track === "URGENT" ? "rose" : "amber"}>{TRACK_LABEL[c.track] ?? c.track}</Badge> : "—"}</td>
              <td className={cx(TD, "text-xs")}>{c.exposure_tag ?? "—"}</td>
              <td className={cx(TD, "text-xs")}><TimeCell value={c.received_at} /></td>
              <td className={cx(TD, "text-xs")}>{at ? <TimeCell value={at} /> : "pending"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ParityPage() {
  const { meta } = useApp();
  const [days, setDays] = useState(14);
  const [tab, setTab] = useState<Tab>("matched");
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const { data, error, loading, reload } = useApi<ParityResponse>("/parity", { days });
  const label = (f: string) => meta?.field_labels[f] ?? f.replace(/_/g, " ");
  const matched = (data?.matched ?? []).filter((m) => !onlyDiffs || m.diffs.length > 0);

  return (
    <div>
      <PageHeader title="Our alerts vs Burson's" description="The alerts found from the team's own tables, next to Burson's alert for the same post. An alert with no match is listed once the wait for a match has passed."
        actions={<>
          <Segmented label="Window" value={days} onChange={setDays} options={[7, 14, 30].map((n) => ({ value: n, label: `${n} d` }))} />
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>
        </>} />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Matched" value={data.summary.matched} help="Posts alerted by both Burson and the in-house pipeline." />
            <Stat label="Burson only" value={data.summary.burson_only} help="Burson alerts the in-house pipeline missed." tone="text-rose-600 dark:text-rose-400" />
            <Stat label="In-house only" value={data.summary.inhouse_only} help="In-house alerts Burson didn't send." tone="text-amber-600 dark:text-amber-400" />
            <Stat label="Recall" value={fmtPct(data.summary.recall, 1)} help="Matched ÷ (matched + Burson only)." />
            <Stat label="Precision" value={fmtPct(data.summary.precision, 1)} help="Matched ÷ (matched + in-house only)." />
            <Stat label="Full agreement" value={fmtPct(data.summary.full_agreement, 1)} help="Matched pairs with no field disagreements." />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card title="Field disagreements" subtitle="Among matched pairs">
              <BarList color={CHART_COLORS[4]} data={data.field_disagreements.map((f) => ({ label: label(f.field), value: f.count }))} valueLabel="Pairs" />
              <ul className="mt-3 space-y-1 text-xs text-zinc-500">
                {data.field_disagreements.map((f) => <li key={f.field}>{label(f.field)}: {fmtPct(f.rate, 1)} of matched pairs</li>)}
              </ul>
            </Card>
            <Card className="xl:col-span-2" padded={false}>
              <div className="px-5 pt-4">
                <Tabs<Tab> value={tab} onChange={setTab} tabs={[
                  { key: "matched", label: "Matched", count: data.matched.length },
                  { key: "burson_only", label: "Burson only", count: data.burson_only.length },
                  { key: "inhouse_only", label: "In-house only", count: data.inhouse_only.length },
                  { key: "pending", label: "In match window", count: data.pending.length },
                ]} />
              </div>
              {tab === "matched" && (
                <>
                  <label className="flex items-center gap-2 px-5 pb-2 text-sm text-zinc-600 dark:text-zinc-300">
                    <input type="checkbox" className="accent-blue-600" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} /> Only pairs with disagreements
                  </label>
                  {matched.length === 0 ? <EmptyState title="No matched pairs" /> : (
                    <div className="scroll-thin max-h-[60vh] overflow-auto">
                      <table className="w-full min-w-[820px]">
                        <thead><tr><th className={TH}>Burson</th><th className={TH}>In-house</th><th className={TH}>Disagreements</th><th className={TH}>Matched</th></tr></thead>
                        <tbody>
                          {matched.map((m) => (
                            <tr key={m.case_ids.join("-")} className={TR}>
                              <td className={cx(TD, "max-w-[16rem]")}><CaseCell c={m.burson} /></td>
                              <td className={cx(TD, "max-w-[16rem]")}><CaseCell c={m.inhouse} /></td>
                              <td className={TD}>
                                {m.diffs.length === 0 ? <Badge tone="emerald">agree</Badge> : (
                                  <ul className="space-y-1 text-xs">
                                    {m.diffs.map((d) => (
                                      <li key={d.field}><span className="font-medium">{label(d.field)}</span>: <span className="text-orange-700 dark:text-orange-400">{fmtValue(d.burson)}</span> vs <span className="text-teal-700 dark:text-teal-400">{fmtValue(d.inhouse)}</span></li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                              <td className={cx(TD, "text-xs")}><TimeCell value={m.matched_at} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
              {tab === "burson_only" && <UnmatchedTable rows={data.burson_only.map((r) => ({ case: r.case, at: r.reconciled_at }))} empty="Every Burson alert was also found by us" />}
              {tab === "inhouse_only" && <UnmatchedTable rows={data.inhouse_only.map((r) => ({ case: r.case, at: r.reconciled_at }))} empty="Nothing was found only by us" />}
              {tab === "pending" && <UnmatchedTable rows={data.pending.map((c) => ({ case: c }))} empty={`Nothing inside the ${data.match_window_hours} h match window`} />}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
