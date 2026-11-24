import { Check, Lightbulb, RefreshCw, X } from "lucide-react";
import { useState } from "react";

import { apiSend } from "../api/client";
import { useApi } from "../api/hooks";
import type { Fact, OpResult, Proposal } from "../api/types";
import { TimeCell } from "../components/common";
import { Alert, Badge, Button, Card, CodeBlock, EmptyState, ErrorState, PageHeader, Segmented, Spinner } from "../components/ui";
import { useApp } from "../context";
import { fmtDateTime } from "../lib/format";
import type { Tone } from "../lib/labels";

type Status = "PENDING" | "APPROVED" | "REJECTED" | "";
const STATUS_TONE: Record<string, Tone> = { PENDING: "amber", APPROVED: "emerald", REJECTED: "zinc" };
// How a fact or a lesson stands, as the server words it
const STANDING: Record<string, { label: string; tone: Tone }> = {
  waiting: { label: "waiting for a lead", tone: "blue" }, held: { label: "held for a lead", tone: "violet" },
  applied: { label: "in use", tone: "emerald" }, rejected: { label: "not in use", tone: "zinc" },
};

function Decide({ disabled, title, onDecide }: { disabled: boolean; title?: string; onDecide: (d: "approve" | "reject") => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (d: "approve" | "reject") => {
    setBusy(d);
    try { await onDecide(d); } finally { setBusy(null); }
  };
  return (
    <div className="flex gap-2" title={title}>
      <Button size="sm" icon={<X className="size-3.5" />} disabled={disabled || busy !== null} loading={busy === "reject"} onClick={() => run("reject")}>Reject</Button>
      <Button size="sm" variant="success" icon={<Check className="size-3.5" />} disabled={disabled || busy !== null} loading={busy === "approve"} onClick={() => run("approve")}>Approve</Button>
    </div>
  );
}

export default function LearningPage() {
  const { me, toast, refreshCounts } = useApp();
  const [status, setStatus] = useState<Status>("PENDING");
  const proposals = useApi<{ proposals: Proposal[]; pending: number; op_available: boolean }>("/proposals", { status: status || undefined });
  const facts = useApi<{ facts: Fact[]; pending: number; op_available: boolean; auto_apply: boolean }>("/facts", { status: status || undefined });

  const decide = (kind: "proposals" | "facts", id: string) => async (decision: "approve" | "reject" | "withdraw") => {
    try {
      const res = await apiSend<OpResult>("post", `/${kind}/${id}`, { decision });
      toast(res.summary || (decision === "withdraw" ? `${id} taken out of use` : `${id} ${decision}d`));
      proposals.reload();
      facts.reload();
      refreshCounts();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Decision failed", "error");
    }
  };

  return (
    <div>
      <PageHeader title="Learning" description="What the team taught the agent: config-change proposals, facts taught in Chat, and lessons from evaluations of its work. A proposal or a taught fact applies only once approved."
        actions={<>
          <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: "PENDING", label: "Pending" }, { value: "APPROVED", label: "Approved" }, { value: "REJECTED", label: "Rejected" }, { value: "", label: "All" }]} />
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => { proposals.reload(); facts.reload(); }}>Refresh</Button>
        </>} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Config-change proposals" subtitle="Approving applies the patch to the live config (admins).">
          {proposals.data && !proposals.data.op_available && <Alert tone="amber" className="mb-3" title="decide_proposal isn't available in this build yet" />}
          <ErrorState error={proposals.error} onRetry={proposals.reload} />
          {proposals.loading && !proposals.data ? <Spinner /> : !proposals.data?.proposals.length ? <EmptyState icon={<Lightbulb className="size-8" />} title="No proposals" /> : (
            <ul className="space-y-3">
              {proposals.data.proposals.map((p) => (
                <li key={p.proposal_id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">{p.proposal_id}</span>
                    <Badge tone={STATUS_TONE[p.status]}>{p.status.toLowerCase()}</Badge>
                    {p.sections.map((s) => <Badge key={s} tone="violet">{s}</Badge>)}
                    {p.preview && <Badge tone={p.preview.valid ? "emerald" : "rose"} title={p.preview.errors.map((e) => `${e.loc.join(".")}: ${e.msg}`).join("\n")}>{p.preview.valid ? "valid patch" : "invalid patch"}</Badge>}
                    <span className="ml-auto text-xs text-zinc-500"><TimeCell value={p.created_at} /></span>
                  </div>
                  <p className="mt-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.summary}</p>
                  <p className="text-xs text-zinc-500">by {p.proposed_by} via {p.via}{p.decided_by ? ` · ${p.status.toLowerCase()} by ${p.decided_by} ${fmtDateTime(p.decided_at)}` : ""}</p>
                  <CodeBlock className="mt-2 max-h-48" value={p.patch} />
                  {p.status === "PENDING" && (
                    <div className="mt-2 flex justify-end">
                      <Decide disabled={!me?.is_admin || !proposals.data!.op_available} title={!me?.is_admin ? "Admins approve config changes" : undefined} onDecide={decide("proposals", p.proposal_id)} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Facts and lessons" subtitle={facts.data?.auto_apply
          ? "A lesson from an evaluation is put to use at once when Gemini finds nothing against it in the lessons in use and the nearest passages of the knowledge documents; one that is held waits here for a lead. A lead can take any of them out of use. A fact taught in Chat always waits for a lead."
          : "A fact or a lesson is used only once a lead or an admin approves it."}>
          {facts.data && !facts.data.op_available && <Alert tone="amber" className="mb-3" title="decide_fact isn't available in this build yet" />}
          <ErrorState error={facts.error} onRetry={facts.reload} />
          {facts.loading && !facts.data ? <Spinner /> : !facts.data?.facts.length ? <EmptyState icon={<Lightbulb className="size-8" />} title="No facts" /> : (
            <ul className="space-y-3">
              {facts.data.facts.map((f) => (
                <li key={f.fact_id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">{f.fact_id}</span>
                    {f.standing ? <Badge tone={STANDING[f.standing.status].tone}>{STANDING[f.standing.status].label}</Badge> : <Badge tone={STATUS_TONE[f.status]}>{f.status.toLowerCase()}</Badge>}
                    <span className="ml-auto text-xs text-zinc-500"><TimeCell value={f.created_at} /></span>
                  </div>
                  <p className="mt-1.5 text-sm text-zinc-900 dark:text-zinc-100">“{f.text}”</p>
                  <p className="text-xs text-zinc-500">{f.source}{f.decided_by ? ` · ${f.status.toLowerCase()} by ${f.decided_by}` : ""}</p>
                  {f.standing && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{f.standing.note}</p>}
                  {f.status === "PENDING" && (
                    <div className="mt-2 flex justify-end">
                      <Decide disabled={!me?.is_lead || !facts.data!.op_available} title={!me?.is_lead ? "Leads and admins approve facts" : undefined} onDecide={decide("facts", f.fact_id)} />
                    </div>
                  )}
                  {f.status === "APPROVED" && me?.is_lead && facts.data!.op_available && (
                    <div className="mt-2 flex justify-end">
                      <Button size="sm" icon={<X className="size-3.5" />} onClick={() => { if (window.confirm(`Take ${f.fact_id} out of use? The agent stops reading it.`)) void decide("facts", f.fact_id)("withdraw"); }}>Take out of use</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
