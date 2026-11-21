import { ExternalLink, Undo2 } from "lucide-react";

import type { Assessment, Attempt, Correction, Issue, RecipientPlan } from "../api/types";
import { useApp } from "../context";
import { fmtDateTime, fmtNum, fmtValue, titleCase } from "../lib/format";
import { TRACK_LABEL } from "../lib/labels";
import { Badge, Button, cx, KV, TD, TH, TR, VerdictBadge } from "./ui";

function Flag({ on, label, tone = "violet" }: { on: boolean; label: string; tone?: "violet" | "pink" | "lime" | "indigo" | "rose" }) {
  return on ? <Badge tone={tone}>{label}</Badge> : null;
}

export function AssessmentPanel({ a }: { a: Assessment }) {
  const { meta } = useApp();
  const actions = new Map((meta?.actions ?? []).map((x) => [x.code, x]));
  return (
    <div className="space-y-4">
      <KV cols={3} items={[
        ["Track", a.track ? <Badge tone={a.track === "URGENT" ? "rose" : "amber"}>{TRACK_LABEL[a.track] ?? a.track}</Badge> : "—"],
        ["Priority", a.priority ?? "—"],
        ["Issue status", a.issue_status ?? "—"],
        ["Exposure tag", a.exposure_tag ?? "—"],
        ["Product", <>{a.product ?? "—"}{a.secondary_products.length > 0 && <span className="text-zinc-500"> (+ {a.secondary_products.join(", ")})</span>}</>],
        ["Alert action", a.alert_action ? titleCase(a.alert_action.toLowerCase()) : "—"],
        ["Sensitive topics", a.sensitive_topics.length ? a.sensitive_topics.join(", ") : "—"],
        ["Engagement", `${a.engagement_level ?? "—"} · ${fmtNum(a.engagement_total)}`],
        ["KOF", a.is_kof ? `Yes${a.kof_lists.length ? ` (${a.kof_lists.join(", ")})` : ""}` : "No"],
        ["Platform", `${a.platform ?? "—"}${a.platform_tier ? ` · ${a.platform_tier} tier` : ""}`],
        ["SLA", a.sla_minutes ? `${a.sla_minutes} min · due ${fmtDateTime(a.sla_due_at)}` : "No SLA"],
        ["Markets", a.non_us_markets.length ? a.non_us_markets.join(", ") : "US / unknown"],
        ["Issue name", a.issue_name ?? "—"],
        ["Related case", a.related_case_id ?? "—"],
        ["Reason codes", a.reason_codes.length ? a.reason_codes.join(", ") : "—"],
      ]} />
      {!a.alertable && (
        <p className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          Not alertable: <span className="font-mono">{a.suppression_reason ?? "unspecified"}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Flag on={a.youtube_protocol !== "none"} label={`▶️ YouTube protocol: ${a.youtube_protocol.replace("_", " ")}`} tone="pink" />
        <Flag on={a.doodle_protocol} label="🎨 Doodle protocol" tone="lime" />
        <Flag on={a.leadership_protocol} label="🔔 Leadership protocol" tone="rose" />
        <Flag on={a.ts_recommended} label={`✍️ T&S recommended${a.ts_reasons.length ? `: ${a.ts_reasons.join(", ")}` : ""}`} tone="indigo" />
        <Flag on={a.bias_allegation} label="Bias allegation" />
        <Flag on={a.sundar_mention} label="Sundar mention" />
        <Flag on={a.owned_post} label="Owned post" />
        <Flag on={a.video_timestamp_needed} label={`Video timestamp: ${a.video_timestamp ?? "needed"}`} />
      </div>
      {a.suggested_actions.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-500">Suggested IM actions</p>
          <div className="flex flex-wrap gap-1.5">
            {a.suggested_actions.map((code) => {
              const act = actions.get(code);
              return <Badge key={code} tone="teal" title={act?.label}>{act ? `${act.emoji} ${act.label}` : code}</Badge>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function CorrectionsTable({ corrections, canRevert, revertible, onRevert, busyField }: {
  corrections: Correction[]; canRevert: boolean; revertible: string[]; onRevert: (field: string) => void; busyField: string | null;
}) {
  const { meta } = useApp();
  if (!corrections.length) return <p className="text-sm text-zinc-500">No corrections on the latest attempt.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full min-w-[640px]">
        <thead><tr><th className={TH}>Field</th><th className={TH}>Old → new</th><th className={TH}>Why</th><th className={TH}>State</th><th className={TH}><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {corrections.map((c, i) => (
            <tr key={`${c.field}-${i}`} className={TR}>
              <td className={cx(TD, "whitespace-nowrap font-medium")}>{meta?.field_labels[c.field] ?? c.field}</td>
              <td className={TD}>
                <span className="text-rose-700 line-through decoration-rose-300 dark:text-rose-400">{fmtValue(c.old)}</span>
                <span className="mx-1.5 text-zinc-400">→</span>
                <span className="font-medium text-emerald-700 dark:text-emerald-400">{fmtValue(c.new)}</span>
              </td>
              <td className={cx(TD, "text-xs text-zinc-500")}>{c.reason || "—"}<br /><span className="font-mono">{c.source} · {c.confidence.toFixed(2)}</span></td>
              <td className={TD}>
                {c.reverted_by ? <Badge tone="zinc" title={`Reverted by ${c.reverted_by}`}>reverted</Badge> : c.applied ? <Badge tone="emerald">applied</Badge> : <Badge tone="amber">proposed</Badge>}
              </td>
              <td className={cx(TD, "text-right")}>
                {c.applied && !c.reverted_by && revertible.includes(c.field) && (
                  <Button size="sm" icon={<Undo2 className="size-3.5" />} disabled={!canRevert || (busyField !== null && busyField !== c.field)}
                    loading={busyField === c.field} onClick={() => onRevert(c.field)} title={canRevert ? "Restore the old value" : "Needs an analyst / IM role"}>
                    Revert
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IssuesList({ issues }: { issues: Issue[] }) {
  const { meta } = useApp();
  if (!issues.length) return <p className="text-sm text-zinc-500">No issues found.</p>;
  return (
    <ul className="space-y-2">
      {issues.map((i, n) => (
        <li key={n} className={cx("rounded-lg border px-3 py-2 text-sm", i.severity === "blocking" ? "border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20" : "border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20")}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={i.severity === "blocking" ? "rose" : "amber"}>{i.severity}</Badge>
            <span className="font-medium">{i.field ? meta?.field_labels[i.field] ?? i.field : "Alert"}</span>
            <span className="font-mono text-xs text-zinc-500">{i.rule}</span>
            <span className="ml-auto text-xs text-zinc-400">{i.source} · {i.confidence.toFixed(2)}</span>
          </div>
          {(i.found || i.expected) && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">Found: {i.found ?? "—"} · Expected: {i.expected ?? "—"}</p>}
          {i.fix && <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">Fix: {i.fix}</p>}
        </li>
      ))}
    </ul>
  );
}

export function RoutingPlan({ plan }: { plan: RecipientPlan | null }) {
  if (!plan) return <p className="text-sm text-zinc-500">No routing plan (alert not alertable).</p>;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {plan.groups.map((g) => <Badge key={g} tone="cyan" title={plan.reasons[g]}>{g}</Badge>)}
        {plan.missing.map((g) => <Badge key={g} tone="amber" title="Matched, but no recipients are configured yet">{g} · no recipients</Badge>)}
      </div>
      <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {Object.entries(plan.reasons).map(([g, why]) => <li key={g}><span className="font-medium text-zinc-800 dark:text-zinc-200">{g}</span>: {why}</li>)}
      </ul>
      <details>
        <summary className="cursor-pointer text-xs text-zinc-500">Recipients: {plan.to.length} to · {plan.cc.length} cc</summary>
        <p className="mt-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">To: {plan.to.join(", ") || "—"}</p>
        <p className="mt-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">Cc: {plan.cc.join(", ") || "—"}</p>
      </details>
      {plan.notes.length > 0 && <ul className="list-disc pl-4 text-xs text-zinc-500">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

export function AttemptsList({ attempts }: { attempts: Attempt[] }) {
  const { meta } = useApp();
  return (
    <ol className="space-y-3">
      {[...attempts].reverse().map((att) => (
        <li key={att.attempt} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">Attempt {att.attempt}</span>
            <VerdictBadge verdict={att.result.verdict} />
            <span className="text-xs text-zinc-500">{fmtDateTime(att.received_at)} · confidence {att.result.confidence.toFixed(2)} · {(att.result.latency_ms / 1000).toFixed(1)} s · {att.result.model ?? "—"}</span>
            {att.message.link && <a href={att.message.link} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400">Chat message <ExternalLink className="size-3" /></a>}
          </div>
          {att.result.review_reasons.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Review: {att.result.review_reasons.join("; ")}</p>}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-zinc-500">Message as received ({att.message.sender.name ?? "unknown sender"})</summary>
            <pre className="scroll-thin mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{att.message.text}</pre>
          </details>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-zinc-500">Fields after corrections</summary>
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
              {Object.entries(att.result.normalized).map(([k, v]) => (
                <div key={k} className="min-w-0"><dt className="text-zinc-500">{meta?.field_labels[k] ?? k}</dt><dd className="break-words">{fmtValue(v)}</dd></div>
              ))}
            </dl>
          </details>
        </li>
      ))}
    </ol>
  );
}
