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
  const facts = useApi<{ facts: Fact[]; pending: number; op_available: boolean }>("/facts", { status: status || undefined });

  const decide = (kind: "proposals" | "facts", id: string) => async (decision: "approve" | "reject") => {
    try {
      const res = await apiSend<OpResult>("post", `/${kind}/${id}`, { decision });
      toast(res.summary || `${id} ${decision}d`);
      proposals.reload();
      facts.reload();
      refreshCounts();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Decision failed", "error");
    }
  };

  return (
    <div>
      <PageHeader title="Learning" description="What IMs taught the agent in chat: config-change proposals (JSON merge patches) and facts used to answer questions. Nothing applies until approved."
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
        <Card title="Facts" subtitle="Approved facts ground the agent's answers (leads and admins).">
          {facts.data && !facts.data.op_available && <Alert tone="amber" className="mb-3" title="decide_fact isn't available in this build yet" />}
          <ErrorState error={facts.error} onRetry={facts.reload} />
          {facts.loading && !facts.data ? <Spinner /> : !facts.data?.facts.length ? <EmptyState icon={<Lightbulb className="size-8" />} title="No facts" /> : (
            <ul className="space-y-3">
              {facts.data.facts.map((f) => (
                <li key={f.fact_id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">{f.fact_id}</span>
                    <Badge tone={STATUS_TONE[f.status]}>{f.status.toLowerCase()}</Badge>
                    <span className="ml-auto text-xs text-zinc-500"><TimeCell value={f.created_at} /></span>
                  </div>
                  <p className="mt-1.5 text-sm text-zinc-900 dark:text-zinc-100">“{f.text}”</p>
                  <p className="text-xs text-zinc-500">{f.source}{f.decided_by ? ` · ${f.status.toLowerCase()} by ${f.decided_by}` : ""}</p>
                  {f.status === "PENDING" && (
                    <div className="mt-2 flex justify-end">
                      <Decide disabled={!me?.is_lead || !facts.data!.op_available} title={!me?.is_lead ? "Leads and admins approve facts" : undefined} onDecide={decide("facts", f.fact_id)} />
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
