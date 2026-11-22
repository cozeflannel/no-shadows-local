import { RefreshCw, Send } from "lucide-react";
import { useState } from "react";

import { useApi } from "../api/hooks";
import type { OutboxResponse } from "../api/types";
import { CaseLink, EscLink, TimeCell } from "../components/common";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, PageHeader, Select, Spinner, Toggle } from "../components/ui";
import { fmtDateTime, fmtDuration } from "../lib/format";
import { TARGET_TONE } from "../lib/labels";

const TARGETS = ["clean", "burson", "dm", "team", "crisis", "youtube", "doodle", "handover"];

export default function OutboxPage() {
  const [undeliveredOnly, setUndeliveredOnly] = useState(false);
  const [target, setTarget] = useState("");
  const { data, error, loading, reload } = useApi<OutboxResponse>("/outbox", { undelivered_only: undeliveredOnly, target: target || undefined, limit: 300 }, 20_000);

  return (
    <div>
      <PageHeader title="Waiting to post" description="Posts the agent has ready that Chat has not posted yet. They go out when the Chat flow next picks them up."
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>} />
      {data && data.stale > 0 && (
        <Alert tone="amber" className="mb-4" title={`${data.stale} item${data.stale > 1 ? "s have" : " has"} waited more than 3 minutes`}>
          {data.doorbell === "none"
            ? "Chat is not told when a post is waiting, so each one waits for the Chat flow's own schedule. Choose how Chat is told under Integrations, Delivery."
            : `Chat is told by ${data.doorbell} when a post is waiting, and told again for one that waits this long.`}
        </Alert>
      )}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <Toggle checked={undeliveredOnly} onChange={setUndeliveredOnly} label="Undelivered only" />
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-48" aria-label="Target">
            <option value="">All targets</option>
            {TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          {data && <span className="text-sm text-zinc-500">{data.undelivered} undelivered · {data.count} total</span>}
        </div>
      </Card>
      <ErrorState error={error} onRetry={reload} />
      <Card padded={false}>
        {loading && !data ? <Spinner /> : !data?.items.length ? <EmptyState icon={<Send className="size-8" />} title="The outbox is empty" /> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.items.map((item) => (
              <li key={item.outbox_id} className={cx("px-5 py-3", item.stale && "bg-amber-50/60 dark:bg-amber-950/20")}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TARGET_TONE[item.target] ?? "zinc"}>{item.target}</Badge>
                  {item.delivered_at ? <Badge tone="emerald" title={`${fmtDateTime(item.delivered_at)} by ${item.delivered_by ?? "—"}`}>delivered in {fmtDuration(item.delivery_s)}</Badge>
                    : <Badge tone={item.stale ? "amber" : "blue"}>{item.stale ? "stale" : "queued"}</Badge>}
                  <CaseLink id={item.case_id} />
                  <EscLink id={item.escalation_id} />
                  <span className="font-mono text-xs text-zinc-400">{item.source}</span>
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
