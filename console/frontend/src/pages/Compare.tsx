import { Link } from "react-router";
import { useState } from "react";

import { useApi } from "../api/hooks";
import { Card, cx, ErrorState, PageHeader, Segmented, Spinner, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";
import { fmtMinutes, fmtNum, fmtPct } from "../lib/format";

type Unit = "count" | "pct" | "min" | "ms" | "hours";
interface Row { key: string; label: string; value: number | null; unit: Unit; note: string; previous: number | null }
interface Section { key: "burson" | "detection" | "ims" | "speed"; title: string; rows: Row[] }
interface CompareResponse {
  window: { days: number; since: string; until: string };
  sections: Section[];
  disagreements: { field: string; count: number; rate: number | null }[];
  event_count: number;
}

function show(value: number | null, unit: Unit): string {
  if (value === null || value === undefined) return "—";
  if (unit === "pct") return fmtPct(value);
  if (unit === "min") return fmtMinutes(value);
  if (unit === "ms") return `${fmtNum(Math.round(value))} ms`;
  if (unit === "hours") return `${fmtNum(value)} h`;
  return fmtNum(value);
}

function change(row: Row): string {
  if (row.value === null || row.previous === null || row.previous === undefined) return "—";
  const diff = row.value - row.previous;
  if (!diff) return "no change";
  const sign = diff > 0 ? "+" : "−";
  const size = Math.abs(diff);
  if (row.unit === "pct") return `${sign}${(size * 100).toFixed(0)} pts`;
  if (row.unit === "min") return `${sign}${fmtMinutes(size)}`;
  if (row.unit === "ms") return `${sign}${fmtNum(Math.round(size))} ms`;
  if (row.unit === "hours") return `${sign}${fmtNum(Math.round(size * 10) / 10)} h`;
  return `${sign}${fmtNum(size)}`;
}

/** The three numbers that answer the page's question at a glance: one each for Burson, the app and the IMs. */
const HEADLINE: { who: string; key: string; says: string }[] = [
  { who: "Burson", key: "first_pass_yield", says: "of Burson's alerts were right as sent" },
  { who: "The app", key: "auto_corrected", says: "alerts fixed by the app before an IM saw them" },
  { who: "The IMs", key: "im_agreement", says: "of IM assessments agreed with the app" },
];

export default function ComparePage() {
  const { meta } = useApp();
  const [days, setDays] = useState(7);
  const data = useApi<CompareResponse>("/compare", { days }, 60_000);
  const rows = new Map((data.data?.sections ?? []).flatMap((s) => s.rows).map((r) => [r.key, r]));
  const fieldLabel = (f: string) => meta?.field_labels[f] ?? f.replace(/_/g, " ");

  return (
    <div>
      <PageHeader title="Burson, the app and the IMs" description={data.data ? `The last ${days} days, next to the ${days} days before` : undefined}
        actions={<Segmented label="Window" value={days} onChange={setDays} options={[7, 14, 30, 90].map((d) => ({ value: d, label: `${d} days` }))} />} />
      <ErrorState error={data.error} onRetry={data.reload} />
      {data.loading && !data.data ? <Spinner /> : data.data && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {HEADLINE.map((h) => {
              const row = rows.get(h.key);
              return (
                <div key={h.key} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{h.who}</p>
                  <p className="mt-2 text-4xl font-medium tabular-nums tracking-tight text-zinc-950 dark:text-zinc-50">{row ? show(row.value, row.unit) : "—"}</p>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{row?.value === null && row.note ? row.note : h.says}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            {data.data.sections.map((section) => (
              <Card key={section.key} title={section.title} padded={false}>
                <table className="w-full border-collapse">
                  <thead><tr><th className={TH}>Measure</th><th className={cx(TH, "text-right")}>Now</th><th className={cx(TH, "text-right")}>Before</th><th className={cx(TH, "text-right")}>Change</th></tr></thead>
                  <tbody>
                    {section.rows.map((r) => (
                      <tr key={r.key} className={TR}>
                        <td className={TD}>{r.label}{r.note && <p className="text-xs text-zinc-500 dark:text-zinc-400">{r.note}</p>}</td>
                        <td className={cx(TD, "text-right font-medium tabular-nums")}>{show(r.value, r.unit)}</td>
                        <td className={cx(TD, "text-right tabular-nums text-zinc-500 dark:text-zinc-400")}>{section.key === "detection" ? "" : show(r.previous, r.unit)}</td>
                        <td className={cx(TD, "text-right tabular-nums text-zinc-500 dark:text-zinc-400")}>{section.key === "detection" ? "" : change(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {section.key === "detection" && (
                  <p className="border-t border-zinc-100 px-5 py-3 text-sm dark:border-zinc-800">
                    <Link to="/parity" className="text-blue-700 hover:underline dark:text-blue-300">Open every alert that was compared</Link>
                  </p>
                )}
              </Card>
            ))}
          </div>

          {data.data.disagreements.length > 0 && (
            <Card className="mt-5" title="Where the app and Burson classified the same post differently" padded={false}>
              <table className="w-full border-collapse">
                <thead><tr><th className={TH}>Field</th><th className={cx(TH, "text-right")}>Alerts</th><th className={cx(TH, "text-right")}>Share of alerts found by both</th></tr></thead>
                <tbody>
                  {data.data.disagreements.map((d) => (
                    <tr key={d.field} className={TR}><td className={TD}>{fieldLabel(d.field)}</td><td className={cx(TD, "text-right tabular-nums")}>{fmtNum(d.count)}</td><td className={cx(TD, "text-right tabular-nums")}>{fmtPct(d.rate)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
