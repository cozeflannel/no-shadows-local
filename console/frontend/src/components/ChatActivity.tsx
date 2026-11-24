import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { useApi } from "../api/hooks";
import { fmtDateTime, fmtRelative, fmtTime } from "../lib/format";
import { Badge, cx, EmptyState, ErrorState, Spinner } from "./ui";

interface Activity {
  activity_id: string; ts: string; direction: "inbound" | "outbound"; kind: string; space_key: string | null; link: string | null; actor: string;
  actor_name: string | null; text: string; emoji: string | null; case_id: string | null; escalation_id: string | null; op: string; status: string;
}
interface Thread { key: string; space_key: string | null; case_id: string | null; first_ts: string; last_ts: string; count: number; participants: string[]; items: Activity[] }
export interface ChatSpace { key: string; name: string; configured: boolean; external: boolean; inbound: number; outbound: number; queued: number; held: number; last: string | null }

const STATUS_TONE: Record<string, "zinc" | "rose" | "violet" | "emerald" | "blue"> = { held: "rose", queued: "violet", failed: "rose", delivered: "emerald", returned: "emerald", received: "blue" };

/** Each Chat space the agent works in: what came in, what went out, and anything held or waiting (the Dashboard's Chat spaces tab). */
export function ChatSpaceCards({ hours, selected, onPick }: { hours: number; selected?: string; onPick: (key: string) => void }) {
  const spaces = useApi<{ spaces: ChatSpace[]; tracked: number }>("/chat/spaces", { hours }, 30_000);
  if (spaces.loading && !spaces.data) return <Spinner />;
  return (
    <div>
      <ErrorState error={spaces.error} onRetry={spaces.reload} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {(spaces.data?.spaces ?? []).map((s) => (
          <button key={s.key} type="button" onClick={() => onPick(s.key)} aria-pressed={selected === s.key}
            className={cx("rounded-2xl border p-4 text-left transition-colors", selected === s.key ? "border-blue-400 bg-blue-50/60 dark:border-blue-300/60 dark:bg-blue-200/10" : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/60",
              s.held > 0 && selected !== s.key && "glow border-transparent dark:border-transparent")}>
            <p className="flex items-center gap-2 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.name}{s.external && <Badge tone="violet">external</Badge>}</p>
            <p className="mt-2 text-2xl font-medium tabular-nums">{s.inbound}<span className="mx-1.5 text-base text-zinc-400">in</span>{s.outbound}<span className="ml-1.5 text-base text-zinc-400">out</span></p>
            <p className="mt-1 truncate text-xs text-zinc-500">
              {!s.configured ? "Not set up in Settings" : s.held ? `${s.held} held by a safety check` : s.queued ? `${s.queued} waiting to post` : s.last ? `last ${fmtRelative(s.last)}` : "quiet"}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The messages the agent read and posted in Chat, a conversation a row; a row opens to every message in it. */
export function ChatThreads({ hours, space, direction, q, full = false }: { hours: number; space: string; direction: string; q: string; full?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const activity = useApi<{ items: Activity[]; threads: Thread[] }>("/chat/activity", { hours, space, direction, q }, 20_000);
  if (activity.loading && !activity.data) return <Spinner />;
  if (activity.error) return <ErrorState error={activity.error} onRetry={activity.reload} />;
  if (!activity.data?.threads.length) {
    return <EmptyState icon={<MessagesSquare className="size-8" />} title="No Chat messages in this window">Messages the agent receives and everything it posts are listed here.</EmptyState>;
  }
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {activity.data.threads.map((t) => {
        const last = t.items[t.items.length - 1];
        const expanded = full || open === t.key;
        return (
          <li key={t.key}>
            <button type="button" onClick={() => setOpen(open === t.key ? null : t.key)} aria-expanded={expanded} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-800 dark:text-zinc-200">
                <span className="mr-2 font-medium text-zinc-900 dark:text-zinc-100">{t.space_key ?? "unknown space"}</span>
                {last.kind === "reaction" ? `Reaction ${last.emoji ?? ""}` : last.text}
              </span>
              {t.case_id && <Badge tone="blue">{t.case_id}</Badge>}
              {t.items.some((i) => i.status === "held") && <Badge tone="rose">held</Badge>}
              <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-zinc-500 sm:block">{t.count} {t.count === 1 ? "item" : "items"}</span>
              <span className="w-32 shrink-0 text-right text-xs tabular-nums text-zinc-500">{fmtDateTime(t.last_ts)}</span>
            </button>
            {expanded && (
              <ol className="space-y-3 border-t border-zinc-100 bg-zinc-50/60 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950/40">
                {t.items.map((m) => (
                  <li key={m.activity_id} className={cx("max-w-3xl rounded-2xl px-4 py-2.5 text-sm", m.direction === "outbound" ? "ml-auto bg-blue-100 text-blue-950 dark:bg-blue-200/15 dark:text-blue-50" : "bg-white dark:bg-zinc-900")}>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className="font-medium">{m.direction === "outbound" ? "Agent" : m.actor_name || m.actor}</span><span>{fmtTime(m.ts)}</span><span>{m.kind}</span>
                      <Badge tone={STATUS_TONE[m.status] ?? "zinc"}>{m.status}</Badge>
                      {m.link && <a href={m.link} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-200">Open in Chat</a>}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words">{m.kind === "reaction" ? `Reaction ${m.emoji ?? ""}` : m.text}</p>
                  </li>
                ))}
                {t.case_id && <li><Link to={`/feed/${t.case_id}`} className="text-sm font-medium text-blue-600 dark:text-blue-200">Open {t.case_id}</Link></li>}
              </ol>
            )}
          </li>
        );
      })}
    </ul>
  );
}
