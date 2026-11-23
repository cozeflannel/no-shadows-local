import { CircleX, ExternalLink } from "lucide-react";
import { useCallback, useState } from "react";
import { Link } from "react-router";

import { apiSend } from "../api/client";
import { useApi } from "../api/hooks";
import type { CaseDetail, CaseSummary, OpResult } from "../api/types";
import { useApp } from "../context";
import { fmtDateTime } from "../lib/format";
import { humanize, SOURCE_LABEL } from "../lib/labels";
import { AssessmentPanel, AttemptsList, CorrectionsTable, IssuesList, RoutingPlan } from "./CaseSections";
import { CaseLink, EventRow } from "./common";
import { EscalationView } from "./EscalationView";
import { Alert, Badge, Button, Card, CaseBadges, Details, Drawer, ErrorState, Field, KV, Modal, Spinner, StatusBadge, Tabs, Textarea } from "./ui";
import { VelocityBadge } from "./VelocityInline";

type Tab = "overview" | "attempts" | "escalations" | "timeline";
const DECISION: Record<string, string> = { forward: "Sent on", bounce: "Sent back to Burson", suppress: "Suppressed" };

function Linked({ label, c }: { label: string; c: CaseSummary | null }) {
  if (!c) return null;
  return <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">{label} <CaseLink id={c.case_id} />{c.status && <StatusBadge status={c.status} />}</span>;
}

export function CaseDrawer({ caseId, onClose, onChanged }: { caseId: string | null; onClose: () => void; onChanged?: () => void }) {
  const { me, meta, toast, refreshCounts } = useApp();
  const { data, error, loading, reload } = useApi<CaseDetail>(caseId ? `/cases/${caseId}` : null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busyField, setBusyField] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closing, setClosing] = useState(false);
  const canAct = !!me?.can_act;

  const after = useCallback((res: OpResult, verb: string) => {
    toast(res.summary || `${verb} ${caseId}`);
    if (res.reply_text) toast(res.reply_text.replace(/^🤖\s*/, ""), "info");
    reload();
    onChanged?.();
    refreshCounts();
  }, [caseId, onChanged, refreshCounts, reload, toast]);

  const revert = async (field: string) => {
    if (!caseId) return;
    setBusyField(field);
    try {
      after(await apiSend<OpResult>("post", `/cases/${caseId}/revert`, { field }), "Reverted");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Revert failed", "error");
    } finally {
      setBusyField(null);
    }
  };

  const close = async () => {
    if (!caseId || !closeReason.trim()) return;
    setClosing(true);
    try {
      after(await apiSend<OpResult>("post", `/cases/${caseId}/close`, { reason: closeReason.trim() }), "Closed");
      setCloseOpen(false);
      setCloseReason("");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Close failed", "error");
    } finally {
      setClosing(false);
    }
  };

  const c = data?.case;
  const latest = c?.attempts[c.attempts.length - 1];
  const a = latest?.result.assessment ?? null;
  const s = data?.summary;

  return (
    <Drawer
      open={!!caseId}
      onClose={onClose}
      title={c ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{c.case_id}</span>
            <CaseBadges status={c.status} verdict={latest?.result.verdict} />
            <Badge tone="zinc">{SOURCE_LABEL[c.source] ?? humanize(c.source)}</Badge>
          </div>
          <h2 className="mt-1 truncate text-base font-semibold text-zinc-950 dark:text-zinc-50" title={c.alert_name ?? ""}>{c.alert_name ?? "Alert"}</h2>
          <div className="mt-1 flex flex-wrap gap-3">
            <Linked label="Counterpart" c={data?.counterpart ?? null} />
            <Linked label="Related" c={data?.related ?? null} />
            <Linked label="Superseded by" c={data?.superseded_by_case ?? null} />
          </div>
        </div>
      ) : <span className="font-mono text-sm">{caseId}</span>}
      actions={c && <>
        <VelocityBadge caseId={c.case_id} postUrl={s?.post_url} compact />
        {s?.post_url && <a href={s.post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950">View post <ExternalLink className="size-3" /></a>}
        {data?.can_close && (
          <Button size="sm" variant="danger" icon={<CircleX className="size-3.5" />} disabled={!canAct || data.operations.close_case === false}
            title={!canAct ? "Needs an analyst or IM role" : data.operations.close_case === false ? "Closing a case isn't available yet" : "Close this case"}
            onClick={() => setCloseOpen(true)}>Close</Button>
        )}
      </>}
    >
      {loading && !data ? <Spinner /> : <ErrorState error={error} onRetry={reload} />}
      {c && s && (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[
            { key: "overview", label: "Overview" },
            { key: "attempts", label: "Attempts", count: c.attempts.length },
            { key: "escalations", label: "Escalations", count: data!.escalations.length },
            { key: "timeline", label: "Timeline", count: data!.events.length },
          ]} />
          {tab === "overview" && (
            <div className="space-y-4">
              {c.status === "NEEDS_REVIEW" && (
                <Alert tone="violet" title="Waiting for an IM's decision">
                  Decide in the <Link className="font-medium underline" to={`/feed/${c.case_id}`}>Review feed</Link>: send it on, send it back to Burson, or suppress it.
                </Alert>
              )}
              {c.status === "FAILED" && <Alert tone="rose" title="Waiting on Burson">Sent back to {c.current_oncall_email ?? "the Burson on-call"} to fix and send again.</Alert>}
              <Card title="Summary">
                <KV cols={3} items={[
                  ["Received", fmtDateTime(s.received_at)],
                  ["Posted to the clean space", fmtDateTime(c.clean_posted_at)],
                  ["Acknowledged", fmtDateTime(c.acknowledged_at)],
                  ["SLA", c.sla_due_at ? `${fmtDateTime(c.sla_due_at)}${c.sla_met === true ? " · met" : c.sla_met === false ? " · missed" : ""}` : "No SLA"],
                  ["On-call told", c.oncall_notices.length ? c.oncall_notices.map((n) => `${n.to_email ?? "—"} (${humanize(n.kind).toLowerCase()})`).join("; ") : "—"],
                  ["IM decision", c.review ? `${DECISION[c.review.decision] ?? humanize(c.review.decision)} by ${c.review.decided_by}${c.review.reason ? `: ${c.review.reason}` : ""}` : "—"],
                  ["Closed", c.closed_reason ?? "—"],
                ]} />
                {c.actions.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-1.5 text-xs font-medium text-zinc-500">IM actions</p>
                    <div className="flex flex-wrap gap-1.5">
                      {c.actions.map((x, i) => {
                        const act = meta?.actions.find((d) => d.code === x.code);
                        return <Badge key={i} tone="emerald" title={`${x.actor} · ${fmtDateTime(x.at)}${x.note ? ` · ${x.note}` : ""}`}>{x.emoji} {act?.label ?? humanize(x.code)}</Badge>;
                      })}
                    </div>
                  </div>
                )}
                <Details summary="Record details" className="mt-4">
                  <KV cols={2} items={[
                    ["Record key", <span className="break-all font-mono text-xs">{c.record_key ?? "—"}</span>],
                    ["Source reference", <span className="break-all font-mono text-xs">{c.source_ref ?? "—"}</span>],
                  ]} />
                </Details>
              </Card>
              {a && <Card title="Assessment"><AssessmentPanel a={a} /></Card>}
              <Card title="Corrections" subtitle="What the agent changed on the latest version of the alert. Undo puts the old value back and checks the alert again.">
                <CorrectionsTable corrections={latest?.result.corrections ?? []} canRevert={canAct && data!.operations.revert_correction !== false}
                  revertible={data!.revertible_fields} onRevert={revert} busyField={busyField} />
              </Card>
              <Card title="Problems found"><IssuesList issues={latest?.result.issues ?? []} /></Card>
              <Card title="Who the email goes to" subtitle="The groups the Social Alert email would be sent to, and why"><RoutingPlan plan={a?.recipients ?? null} /></Card>
            </div>
          )}
          {tab === "attempts" && <AttemptsList attempts={c.attempts} />}
          {tab === "escalations" && (
            <div className="space-y-4">
              {data!.escalations.length === 0 ? <p className="text-sm text-zinc-500">No escalations for this case.</p>
                : data!.escalations.map((e) => <Card key={e.escalation_id}><EscalationView esc={e} /></Card>)}
            </div>
          )}
          {tab === "timeline" && (
            <Card padded={false}><ul className="px-4">{data!.events.map((e) => <EventRow key={e.event_id} event={e} compact showCase={false} />)}</ul></Card>
          )}
        </>
      )}
      <Modal open={closeOpen} onClose={() => setCloseOpen(false)} title={`Close ${caseId}`}
        footer={<>
          <Button onClick={() => setCloseOpen(false)}>Cancel</Button>
          <Button variant="danger" loading={closing} disabled={!closeReason.trim()} onClick={close}>Close case</Button>
        </>}>
        <Field label="Reason" hint="Kept on the case and in its timeline.">
          <Textarea rows={3} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="Actions done; no further follow-up needed" className="font-sans text-sm" />
        </Field>
      </Modal>
    </Drawer>
  );
}
