import { ExternalLink, Mail } from "lucide-react";
import { useState } from "react";

import type { EmailState, Escalation, TnsState } from "../api/types";
import { fmtDateTime } from "../lib/format";
import { humanize, type Tone } from "../lib/labels";
import { CaseLink } from "./common";
import { Badge, cx, Details, KV } from "./ui";

export const EMAIL_STATUS_TONE: Record<string, Tone> = {
  DRAFTED: "blue", REVISION_REQUESTED: "violet", REDRAFTED: "blue", SENT: "emerald", DISCARDED: "zinc", FAILED: "rose",
};
export const EMAIL_STATUS_LABEL: Record<string, string> = {
  DRAFTED: "Drafted", REVISION_REQUESTED: "Edit asked for", REDRAFTED: "Redrafted", SENT: "Sent", DISCARDED: "Discarded", FAILED: "Failed",
};
export const TNS_STATUS_TONE: Record<string, Tone> = { ASSESSED: "blue", NOT_ELIGIBLE: "zinc", PREPARED: "violet", SUBMITTED: "emerald", WITHDRAWN: "zinc" };
export const TNS_STATUS_LABEL: Record<string, string> = { ASSESSED: "Assessed", NOT_ELIGIBLE: "Not eligible", PREPARED: "Form ready", SUBMITTED: "Submitted", WITHDRAWN: "Withdrawn" };
const PURPOSE_LABEL: Record<string, string> = { alert: "Social Alert", tns_urgent: "T&S urgent", bug_followup: "Bug-ID follow-up", group: "Group" };
/** What started an escalation, in words. */
export const TRIGGER_LABEL: Record<string, string> = {
  auto_urgent: "Drafted by the agent (urgent)", reaction: "From an emoji in Chat", chat: "From a Chat reply", console: "From the Console", email: "From an email",
};
export const triggerLabel = (t: string) => TRIGGER_LABEL[t] ?? humanize(t);

function EmailBlock({ email }: { email: EmailState }) {
  const [version, setVersion] = useState(email.versions.length ? email.versions[email.versions.length - 1].version : 0);
  const v = email.versions.find((x) => x.version === version);
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <Mail className="size-4 text-zinc-400" />
        <span className="text-sm font-medium">{PURPOSE_LABEL[email.purpose] ?? email.purpose}</span>
        <Badge tone={EMAIL_STATUS_TONE[email.status] ?? "zinc"}>{EMAIL_STATUS_LABEL[email.status] ?? humanize(email.status)}</Badge>
        {email.in_reply_to && <Badge tone="zinc" title={email.in_reply_to}>Reply in the thread</Badge>}
        {email.revision_requests > 0 && <Badge tone="violet">{email.revision_requests} edit{email.revision_requests > 1 ? "s" : ""} asked for</Badge>}
        <span className="ml-auto text-xs text-zinc-500">{email.sent_at ? `sent ${fmtDateTime(email.sent_at)}` : email.drafted_at ? `drafted ${fmtDateTime(email.drafted_at)}` : ""}</span>
      </div>
      {email.error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{email.error}</p>}
      {email.groups.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">{email.groups.map((g) => <Badge key={g} tone="blue">{g}</Badge>)}</div>
      )}
      {email.versions.length > 0 && (
        <div className="mt-3">
          {email.versions.length > 1 && (
            <div className="mb-2 flex gap-1" role="tablist" aria-label="Draft versions">
              {email.versions.map((x) => (
                <button key={x.version} type="button" onClick={() => setVersion(x.version)} aria-selected={x.version === version}
                  className={cx("rounded-md px-2 py-0.5 text-xs font-medium transition-colors", x.version === version ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300")}>
                  v{x.version}
                </button>
              ))}
            </div>
          )}
          {v && (
            <div className="space-y-1.5 text-xs">
              {v.instruction && <p className="text-violet-800 dark:text-violet-300">Edit asked for: “{v.instruction}”</p>}
              <p><span className="text-zinc-500">From:</span> {email.from_alias ?? "—"}</p>
              <p><span className="text-zinc-500">Subject:</span> <span className="font-medium">{v.subject}</span></p>
              <details>
                <summary className="cursor-pointer text-zinc-500">
                  To ({v.to.length}) · Cc ({v.cc.length}){(v.bcc?.length ?? 0) > 0 ? ` · Bcc (${v.bcc?.length})` : ""}
                </summary>
                <p className="mt-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">To: {v.to.join(", ") || "—"}</p>
                <p className="mt-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">Cc: {v.cc.join(", ") || "—"}</p>
                {(v.bcc?.length ?? 0) > 0 && (
                  <p className="mt-1 break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-400">Bcc: {v.bcc?.join(", ")}</p>
                )}
              </details>
              {(v as { html_body?: string }).html_body ? (
                <div className="space-y-1.5">
                  <iframe
                    title={`HTML Email Preview v${v.version}`}
                    srcDoc={(v as { html_body?: string }).html_body}
                    className="h-72 w-full rounded-md border border-zinc-200 bg-white"
                  />
                  <details>
                    <summary className="cursor-pointer text-[11px] text-zinc-500">Plain-text fallback</summary>
                    <pre className="scroll-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2.5 font-sans text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{v.body}</pre>
                  </details>
                </div>
              ) : (
                <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2.5 font-sans text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{v.body}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TnsBlock({ tns }: { tns: TnsState }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">✍️ Trust & Safety</span>
        <Badge tone={TNS_STATUS_TONE[tns.status] ?? "zinc"}>{TNS_STATUS_LABEL[tns.status] ?? humanize(tns.status)}</Badge>
        {tns.urgent && <Badge tone="rose">Urgent</Badge>}
        {tns.outcome && <Badge tone={tns.outcome === "Fixed" ? "emerald" : "zinc"}>Outcome: {tns.outcome}</Badge>}
        {tns.bug_id && <Badge tone="violet">b/{tns.bug_id}</Badge>}
      </div>
      <KV cols={3} items={[
        ["Eligible", tns.eligible ? "Yes" : "No"],
        ["Category", tns.category ?? "—"],
        ["Evidence", tns.evidence ?? "—"],
        ["Watchdog issue", tns.wd_issue_id ?? "—"],
        ["Submitted", tns.submitted_at ? `${fmtDateTime(tns.submitted_at)}${tns.submitted_by ? ` by ${tns.submitted_by}` : ""}` : "—"],
        ["Outcome at", fmtDateTime(tns.outcome_at)],
        ["Follow-up sent", fmtDateTime(tns.bug_followup_sent_at)],
        ["Pre-filled form", tns.prefill_url ? <a className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400" href={tns.prefill_url} target="_blank" rel="noreferrer">Open <ExternalLink className="size-3" /></a> : "—"],
      ]} />
      {tns.rationale && <p className="mt-2 text-xs text-zinc-500">{tns.rationale}</p>}
      {tns.criteria_ids.length > 0 && (
        <Details summary="Criteria it met" className="mt-2"><p className="font-mono text-xs text-zinc-500">{tns.criteria_ids.join(", ")}</p></Details>
      )}
    </div>
  );
}

export function EscalationView({ esc, showCase = false }: { esc: Escalation; showCase?: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-semibold">{esc.escalation_id}</span>
        {showCase && <CaseLink id={esc.case_id} />}
        <Badge tone={esc.is_open ? "violet" : "zinc"}>{esc.is_open ? "Open" : "Done"}</Badge>
        <Badge tone="zinc">{triggerLabel(esc.trigger)}</Badge>
        <span className="text-xs text-zinc-500">IM {esc.analyst_email} · requested {fmtDateTime(esc.requested_at)}{esc.requested_by && esc.requested_by !== esc.analyst_email ? ` by ${esc.requested_by}` : ""}</span>
      </div>
      {esc.emails.map((e, i) => <EmailBlock key={`${e.purpose}-${i}`} email={e} />)}
      {esc.tns && <TnsBlock tns={esc.tns} />}
      {esc.emails.length === 0 && !esc.tns && <p className="text-sm text-zinc-500">No drafts or T&S form yet.</p>}
    </div>
  );
}
