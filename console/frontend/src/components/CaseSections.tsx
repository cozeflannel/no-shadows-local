import { ExternalLink, Undo2 } from "lucide-react";

import type { Assessment, Attempt, Correction, Issue, RecipientPlan } from "../api/types";
import { useApp } from "../context";
import { fmtDateTime, fmtNum, fmtValue, probability, titleCase } from "../lib/format";
import { humanize, plainReason, suppressionLabel, TRACK_LABEL } from "../lib/labels";
import { Badge, Button, cx, Details, KV, TD, TH, TR, VerdictBadge } from "./ui";

/** Where a correction or a found problem came from, in words. */
const FROM: Record<string, string> = { parser: "reading the alert", rule: "a fixed rule", reference: "the reference lists", llm: "Gemini" };
const SEVERITY: Record<string, { label: string; tone: "rose" | "violet" }> = { blocking: { label: "Must fix", tone: "rose" }, warning: { label: "Check", tone: "violet" } };

function Flag({ on, label, tone = "violet" }: { on: boolean; label: string; tone?: "violet" | "rose" | "blue" | "emerald" }) {
  return on ? <Badge tone={tone}>{label}</Badge> : null;
}

export function AssessmentPanel({ a }: { a: Assessment }) {
  const { meta } = useApp();
  const actions = new Map((meta?.actions ?? []).map((x) => [x.code, x]));
  return (
    <div className="space-y-4">
      <KV cols={3} items={[
        ["Track", a.track ? <Badge tone={a.track === "URGENT" ? "rose" : "blue"}>{TRACK_LABEL[a.track] ?? a.track}</Badge> : "—"],
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
      ]} />
      {!a.alertable && (
        <p className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          Not alertable: {suppressionLabel(a.suppression_reason)}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Flag on={a.youtube_protocol !== "none"} label={`▶️ YouTube protocol: ${humanize(a.youtube_protocol).toLowerCase()}`} tone="rose" />
        <Flag on={a.doodle_protocol} label="🎨 Doodle protocol" tone="blue" />
        <Flag on={a.leadership_protocol} label="🔔 Leadership protocol" tone="rose" />
        <Flag on={a.ts_recommended} label={`✍️ T&S recommended${a.ts_reasons.length ? `: ${a.ts_reasons.join(", ")}` : ""}`} tone="blue" />
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
              return <Badge key={code} tone="emerald" title={act?.label}>{act ? `${act.emoji} ${act.label}` : humanize(code)}</Badge>;
            })}
          </div>
        </div>
      )}
      {a.reason_codes.length > 0 && (
        <Details summary="Rule codes behind this assessment">
          <p className="break-words font-mono text-xs text-zinc-500 dark:text-zinc-400">{a.reason_codes.join(", ")}</p>
        </Details>
      )}
    </div>
  );
}

export function CorrectionsTable({ corrections, canRevert, revertible, onRevert, busyField }: {
  corrections: Correction[]; canRevert: boolean; revertible: string[]; onRevert: (field: string) => void; busyField: string | null;
}) {
  const { meta } = useApp();
  if (!corrections.length) return <p className="text-sm text-zinc-500">Nothing was changed on the latest version of the alert.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full min-w-[640px]">
        <thead><tr><th className={TH}>Field</th><th className={TH}>Was → now</th><th className={TH}>Why</th><th className={TH}>State</th><th className={TH}><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {corrections.map((c, i) => (
            <tr key={`${c.field}-${i}`} className={TR}>
              <td className={cx(TD, "whitespace-nowrap font-medium")}>{meta?.field_labels[c.field] ?? c.field}</td>
              <td className={TD}>
                <span className="text-rose-700 line-through decoration-rose-300 dark:text-rose-400">{fmtValue(c.old)}</span>
                <span className="mx-1.5 text-zinc-400">→</span>
                <span className="font-medium text-emerald-700 dark:text-emerald-400">{fmtValue(c.new)}</span>
              </td>
              <td className={cx(TD, "text-xs text-zinc-500")}>
                {c.reason || "—"}
                <span className="block">From {FROM[c.source] ?? humanize(c.source)}{probability(c.confidence) !== null ? ` · ${Math.round((probability(c.confidence) ?? 0) * 100)}% likely right` : ""}</span>
              </td>
              <td className={TD}>
                {c.reverted_by ? <Badge tone="zinc" title={`Undone by ${c.reverted_by}`}>Undone</Badge> : c.applied ? <Badge tone="emerald">Applied</Badge> : <Badge tone="violet">Suggested</Badge>}
              </td>
              <td className={cx(TD, "text-right")}>
                {c.applied && !c.reverted_by && revertible.includes(c.field) && (
                  <Button size="sm" icon={<Undo2 className="size-3.5" />} disabled={!canRevert || (busyField !== null && busyField !== c.field)}
                    loading={busyField === c.field} onClick={() => onRevert(c.field)} title={canRevert ? "Put the old value back" : "Needs an analyst or IM role"}>
                    Undo
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
  if (!issues.length) return <p className="text-sm text-zinc-500">No problems found.</p>;
  return (
    <ul className="space-y-2">
      {issues.map((i, n) => (
        <li key={n} className={cx("rounded-lg border px-3 py-2 text-sm", i.severity === "blocking" ? "border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20" : "border-violet-200 bg-violet-50/60 dark:border-violet-900/50 dark:bg-violet-950/20")}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY[i.severity]?.tone ?? "violet"}>{SEVERITY[i.severity]?.label ?? humanize(i.severity)}</Badge>
            <span className="font-medium" title={i.rule}>{i.field ? meta?.field_labels[i.field] ?? humanize(i.field) : "The alert"}</span>
            <span className="ml-auto text-xs text-zinc-500">Found by {FROM[i.source] ?? humanize(i.source)}{probability(i.confidence) !== null ? ` · ${Math.round((probability(i.confidence) ?? 0) * 100)}% likely real` : ""}</span>
          </div>
          {(i.found || i.expected) && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">Found: {i.found ?? "—"} · Expected: {i.expected ?? "—"}</p>}
          {i.fix && <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">Fix: {i.fix}</p>}
        </li>
      ))}
    </ul>
  );
}

export function RoutingPlan({ plan }: { plan: RecipientPlan | null }) {
  if (!plan) return <p className="text-sm text-zinc-500">No one to email: the alert is not alertable.</p>;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {plan.groups.map((g) => <Badge key={g} tone="blue" title={plan.reasons[g]}>{g}</Badge>)}
        {plan.missing.map((g) => <Badge key={g} tone="violet" title="It matched, but no one is on this group's list yet">{g} · no one on the list yet</Badge>)}
      </div>
      <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {Object.entries(plan.reasons).map(([g, why]) => <li key={g}><span className="font-medium text-zinc-800 dark:text-zinc-200">{g}</span>: {why}</li>)}
      </ul>
      <details>
        <summary className="cursor-pointer text-xs text-zinc-500">Who exactly: {plan.to.length} to · {plan.cc.length} cc</summary>
        <p className="mt-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">To: {plan.to.join(", ") || "—"}</p>
        <p className="mt-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">Cc: {plan.cc.join(", ") || "—"}</p>
      </details>
      {plan.notes.length > 0 && <ul className="list-disc pl-4 text-xs text-zinc-500">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

export function AttemptsList({ attempts }: { attempts: Attempt[] }) {
  const { meta } = useApp();
  const label = (f: string) => meta?.field_labels[f] ?? humanize(f);
  return (
    <ol className="space-y-3">
      {[...attempts].reverse().map((att) => (
        <li key={att.attempt} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">Attempt {att.attempt}</span>
            <VerdictBadge verdict={att.result.verdict} />
            <span className="text-xs text-zinc-500" title={`Checked in ${(att.result.latency_ms / 1000).toFixed(1)} s${att.result.model ? ` by ${att.result.model}` : ""}`}>
              {fmtDateTime(att.received_at)}{att.result.burson && att.result.burson.pct !== null ? ` · Burson ${att.result.burson.right} of ${att.result.burson.filled} fields right` : ""}
            </span>
            {att.message.link && <a href={att.message.link} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400">Chat message <ExternalLink className="size-3" /></a>}
          </div>
          {att.result.review_reasons.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-violet-800 dark:text-violet-300">{att.result.review_reasons.map((r, i) => <li key={i}>{plainReason(r, label)}</li>)}</ul>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-zinc-500">Message as received ({att.message.sender.name ?? "unknown sender"})</summary>
            <pre className="scroll-thin mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{att.message.text}</pre>
          </details>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-zinc-500">Fields after corrections</summary>
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
              {Object.entries(att.result.normalized).map(([k, v]) => (
                <div key={k} className="min-w-0"><dt className="text-zinc-500">{label(k)}</dt><dd className="break-words">{fmtValue(v)}</dd></div>
              ))}
            </dl>
          </details>
        </li>
      ))}
    </ol>
  );
}
