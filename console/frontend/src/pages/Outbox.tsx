import { RefreshCw, Send } from "lucide-react";
import { useState } from "react";

import { useApi } from "../api/hooks";
import type { OutboxResponse } from "../api/types";
import { CaseLink, EscLink, TimeCell } from "../components/common";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, PageHeader, Select, Spinner, Toggle } from "../components/ui";
import { fmtDateTime, fmtDuration } from "../lib/format";
import { humanize, TARGET_LABEL, TARGET_TONE } from "../lib/labels";

const TARGETS = ["clean", "dm", "team", "crisis", "youtube", "doodle", "handover"];

export default function OutboxPage() {
  const [undeliveredOnly, setUndeliveredOnly] = useState(false);
  const [target, setTarget] = useState("");
  const { data, error, loading, reload } = useApi<OutboxResponse>("/outbox", { undelivered_only: undeliveredOnly, target: target || undefined, limit: 300 }, 20_000);

  return (
    <div>
      <PageHeader title="Waiting to post"
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>} />
      {data && data.stale > 0 && (
        <Alert tone="violet" className="mb-4" title={`${data.stale} post${data.stale > 1 ? "s have" : " has"} waited more than 3 minutes`}>
          Posts go directly to Google Chat each minute once &ldquo;Post queued messages in Chat&rdquo; is turned on under Settings, Switches.
        </Alert>
      )}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <Toggle checked={undeliveredOnly} onChange={setUndeliveredOnly} label="Not posted yet only" />
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-48" aria-label="Where it goes">
            <option value="">Everywhere</option>
            {TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABEL[t] ?? humanize(t)}</option>)}
          </Select>
          {data && <span className="text-sm text-zinc-500">{data.undelivered} not posted yet · {data.count} in all</span>}
        </div>
      </Card>
      <ErrorState error={error} onRetry={reload} />
      <Card padded={false}>
        {loading && !data ? <Spinner /> : !data?.items.length ? <EmptyState icon={<Send className="size-8" />} title="Nothing is waiting to post" /> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.items.map((item) => (
              <li key={item.outbox_id} className={cx("px-5 py-3", item.stale && "bg-violet-50/60 dark:bg-violet-950/20")} title={item.source ? `Written by ${item.source}` : undefined}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TARGET_TONE[item.target] ?? "zinc"}>{TARGET_LABEL[item.target] ?? humanize(item.target)}</Badge>
                  {item.delivered_at ? <Badge tone="emerald" title={`${fmtDateTime(item.delivered_at)} by ${item.delivered_by ?? "—"}`}>Posted after {fmtDuration(item.delivery_s)}</Badge>
                    : <Badge tone={item.stale ? "violet" : "blue"}>{item.stale ? "Waiting too long" : "Waiting"}</Badge>}
                  <CaseLink id={item.case_id} />
                  <EscLink id={item.escalation_id} />
                  {item.recipients.length > 0 && <span className="truncate text-xs text-zinc-500">→ {item.recipients.join(", ")}</span>}
                  <span className="ml-auto text-xs text-zinc-500"><TimeCell value={item.created_at} /></span>
                </div>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300" title={item.text}>{item.text}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
