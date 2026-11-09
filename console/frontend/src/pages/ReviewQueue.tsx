import { Ban, CornerUpLeft, Forward, Inbox, Plus, RefreshCw, Trash } from "lucide-react";
import { useState } from "react";

import { apiSend } from "../api/client";
import { useApi } from "../api/hooks";
import type { FieldMeta, OnCallResolution, OpResult, ReviewItem } from "../api/types";
import { CaseLink } from "../components/common";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { useApp } from "../context";
import { fmtCompact, fmtMinutes, fmtValue } from "../lib/format";
import { TRACK_LABEL } from "../lib/labels";

interface QueueResponse { cases: ReviewItem[]; im_on_shift: OnCallResolution; op_available: boolean; review_reminder_min: number }
type Override = { field: string; value: string };

function coerce(meta: FieldMeta | undefined, raw: string): unknown {
  const v = raw.trim();
  if (!meta) return v;
  if (meta.type === "integer") return v === "" ? null : Number(v.replace(/,/g, ""));
  if (meta.type === "number") return v === "" ? null : Number(v);
  if (meta.type === "boolean") return v === "true";
  if (meta.type === "list") return v.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  return v;
}

function OverrideEditor({ fields, rows, onChange, disabled }: { fields: FieldMeta[]; rows: Override[]; onChange: (rows: Override[]) => void; disabled: boolean }) {
  const set = (i: number, patch: Partial<Override>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        const meta = fields.find((f) => f.name === r.field);
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select value={r.field} onChange={(e) => set(i, { field: e.target.value, value: "" })} className="w-48" aria-label="Field" disabled={disabled}>
              {fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
            </Select>
            {meta?.allowed ? (
              <Select value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="min-w-0 flex-1" aria-label="Value" disabled={disabled}>
                <option value="">Choose…</option>
                {meta.allowed.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            ) : meta?.type === "boolean" ? (
              <Select value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="min-w-0 flex-1" aria-label="Value" disabled={disabled}>
                <option value="true">Yes</option><option value="false">No</option>
              </Select>
            ) : (
              <Input value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="min-w-0 flex-1" aria-label="Value" disabled={disabled}
                placeholder={meta?.type === "list" ? "comma-separated" : meta?.description || "new value"} />
            )}
            <button type="button" aria-label="Remove override" disabled={disabled} onClick={() => onChange(rows.filter((_, n) => n !== i))}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-rose-600 dark:hover:bg-zinc-800"><Trash className="size-4" /></button>
          </div>
        );
      })}
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={disabled || !fields.length}
        onClick={() => onChange([...rows, { field: fields[0]?.name ?? "", value: fields[0]?.type === "boolean" ? "true" : "" }])}>
        Override a field
      </Button>
    </div>
  );
}

function ReviewCard({ item, canAct, opAvailable, onDone }: { item: ReviewItem; canAct: boolean; opAvailable: boolean; onDone: () => void }) {
  const { meta, toast, refreshCounts } = useApp();
  const [reason, setReason] = useState("");
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const fields = (meta?.fields ?? []).filter((f) => f.correctable);
  const disabled = !canAct || !opAvailable || busy !== null;

  const decide = async (decision: "forward" | "bounce" | "suppress") => {
    if (decision === "bounce" && !reason.trim()) {
      toast("Add a reason so the Burson on-call knows what to fix.", "error");
      return;
    }
    setBusy(decision);
    try {
      const fieldsBody = decision === "forward" && overrides.length
        ? Object.fromEntries(overrides.filter((o) => o.field).map((o) => [o.field, coerce(fields.find((f) => f.name === o.field), o.value)]))
        : undefined;
      const res = await apiSend<OpResult>("post", `/review-queue/${item.case_id}`, { decision, reason: reason.trim() || undefined, fields: fieldsBody });
      toast(res.summary || `${item.case_id}: ${decision}`);
      refreshCounts();
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Decision failed", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CaseLink id={item.case_id} />
            {item.track && <Badge tone={item.track === "URGENT" ? "rose" : "amber"}>{TRACK_LABEL[item.track] ?? item.track}</Badge>}
            {item.priority && <Badge tone="slate">{item.priority}</Badge>}
            <Badge tone="amber">confidence {item.confidence?.toFixed(2) ?? "—"}</Badge>
            <span className="text-xs text-zinc-500">waiting {fmtMinutes(item.waiting_min)}</span>
          </div>
          <h3 className="mt-1.5 font-semibold text-zinc-950 dark:text-zinc-50">{item.alert_name}</h3>
          <p className="text-xs text-zinc-500">{[item.product, item.exposure_tag, item.platform, item.engagement_total !== null ? `${fmtCompact(item.engagement_total)} engagements` : null].filter(Boolean).join(" · ")}</p>
        </div>
        {item.post_url && <a href={item.post_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline dark:text-blue-400">View post ↗</a>}
      </div>

      {item.review_reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-amber-800 dark:text-amber-300">{item.review_reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      {(item.proposed_corrections ?? []).length > 0 && (
        <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
          <p className="mb-1 text-xs font-medium text-zinc-500">Proposed by the agent (applied when you forward)</p>
          {(item.proposed_corrections ?? []).map((c, i) => (
            <p key={i}>
              <span className="font-medium">{meta?.field_labels[c.field] ?? c.field}</span>: <span className="text-rose-700 line-through dark:text-rose-400">{fmtValue(c.old)}</span>
              {" → "}<span className="font-medium text-emerald-700 dark:text-emerald-400">{fmtValue(c.new)}</span>
              <span className="ml-2 font-mono text-xs text-zinc-500">{c.confidence.toFixed(2)}</span>
              {c.reason && <span className="ml-2 text-xs text-zinc-500">{c.reason}</span>}
            </p>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Field label="Field overrides (forward only)"><OverrideEditor fields={fields} rows={overrides} onChange={setOverrides} disabled={disabled} /></Field>
        <Field label="Reason" hint="Required to bounce; shown to Burson / logged with the decision.">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={disabled} className="font-sans text-sm" placeholder="e.g. Link is a profile page, not the post" />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button icon={<Ban className="size-4" />} disabled={disabled} loading={busy === "suppress"} onClick={() => decide("suppress")}>Suppress</Button>
        <Button variant="danger" icon={<CornerUpLeft className="size-4" />} disabled={disabled} loading={busy === "bounce"} onClick={() => decide("bounce")}>Bounce to Burson</Button>
        <Button variant="success" icon={<Forward className="size-4" />} disabled={disabled} loading={busy === "forward"} onClick={() => decide("forward")}>Forward to clean space</Button>
      </div>
    </Card>
  );
}

export default function ReviewQueuePage() {
  const { me } = useApp();
  const { data, error, loading, reload } = useApi<QueueResponse>("/review-queue", undefined, 30_000);
  return (
    <div>
      <PageHeader title="Review queue" description="Alerts the agent wasn't confident about. Forward (optionally overriding fields), bounce to Burson, or suppress. Posts go out through the outbox."
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>} />
      {data && !data.op_available && <Alert tone="amber" className="mb-4" title="review_decision isn't available in this build yet">Decisions are disabled until the agent is updated.</Alert>}
      {me && !me.can_act && <Alert tone="blue" className="mb-4" title="Read-only">Only SLRR analysts and Incident Managers can decide on held alerts.</Alert>}
      {data?.im_on_shift.person && <p className="mb-3 text-sm text-zinc-500">IM on shift: <span className="font-medium text-zinc-800 dark:text-zinc-200">{data.im_on_shift.person.name}</span> ({data.im_on_shift.person.email}) · reminders after {data.review_reminder_min} min</p>}
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && data.cases.length === 0 ? (
        <Card><EmptyState icon={<Inbox className="size-8" />} title="Nothing waiting for review">New held alerts appear here and are DMed to the IM on shift.</EmptyState></Card>
      ) : (
        <div className="space-y-4">{data?.cases.map((c) => <ReviewCard key={c.case_id} item={c} canAct={!!me?.can_act} opAvailable={data.op_available} onDone={reload} />)}</div>
      )}
    </div>
  );
}
