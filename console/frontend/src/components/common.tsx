import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { AgentEvent } from "../api/types";
import { fmtDateTime, fmtRelative, fmtTime } from "../lib/format";
import { eventTone } from "../lib/labels";
import { Badge, CodeBlock, cx } from "./ui";

/** Case id chip that opens the case drawer (/cases/:id). */
export function CaseLink({ id, className }: { id: string | null | undefined; className?: string }) {
  if (!id) return <span className="text-zinc-400">—</span>;
  return (
    <Link to={`/cases/${id}`} className={cx("whitespace-nowrap rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/60", className)}>
      {id}
    </Link>
  );
}

export function EscLink({ id }: { id: string | null | undefined }) {
  if (!id) return null;
  return (
    <Link to={`/escalations?q=${id}`} className="whitespace-nowrap rounded bg-cyan-50 px-1.5 py-0.5 font-mono text-xs font-medium text-cyan-800 transition-colors hover:bg-cyan-100 dark:bg-cyan-900/30 dark:text-cyan-300">
      {id}
    </Link>
  );
}

export function TimeCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-zinc-400">—</span>;
  return (
    <span title={fmtDateTime(value)} className="whitespace-nowrap">
      <span className="text-zinc-800 dark:text-zinc-200">{fmtRelative(value)}</span>
    </span>
  );
}

/** One event line (Activity feed, case timeline) with an expandable payload. */
export function EventRow({ event, compact = false, showCase = true }: { event: AgentEvent; compact?: boolean; showCase?: boolean }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Object.keys(event.payload ?? {}).length > 0 || event.error_codes.length > 0;
  return (
    <li className="group border-b border-zinc-100 last:border-0 dark:border-zinc-800/70">
      <div className="flex items-start gap-3 px-1 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={!hasDetail}
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          className="mt-0.5 rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:invisible dark:hover:bg-zinc-800"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="w-[4.5rem] shrink-0 pt-0.5 text-xs text-zinc-500" title={fmtDateTime(event.event_ts)}>
          {compact ? fmtTime(event.event_ts) : fmtRelative(event.event_ts)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={eventTone(event.event_type)} className="font-mono">{event.event_type}</Badge>
            {showCase && event.case_id && <CaseLink id={event.case_id} />}
            {event.escalation_id && <EscLink id={event.escalation_id} />}
            {event.actor && event.actor !== "agent" && <span className="truncate text-xs text-zinc-500">by {event.actor}</span>}
          </div>
          <p className="mt-1 break-words text-sm text-zinc-700 dark:text-zinc-300">{event.summary}</p>
        </div>
        {!compact && <span className="hidden shrink-0 pt-0.5 text-xs text-zinc-400 sm:block">{fmtDateTime(event.event_ts)}</span>}
      </div>
      {open && (
        <div className="pb-3 pl-9">
          <CodeBlock value={{ ...event.payload, ...(event.error_codes.length ? { error_codes: event.error_codes } : {}),
            ...(event.latency_ms !== null ? { latency_ms: event.latency_ms } : {}), ...(event.model ? { model: event.model } : {}),
            space: event.space, attempt: event.attempt, config_version: event.config_version }} />
        </div>
      )}
    </li>
  );
}
