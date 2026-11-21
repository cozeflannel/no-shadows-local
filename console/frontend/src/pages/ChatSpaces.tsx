import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { useApi } from "../api/hooks";
import { Badge, Card, cx, EmptyState, ErrorState, Input, PageHeader, Segmented, Select, Spinner } from "../components/ui";
import { fmtDateTime, fmtRelative, fmtTime } from "../lib/format";

interface Activity {
  activity_id: string; ts: string; direction: "inbound" | "outbound"; kind: string; space_key: string | null; link: string | null; actor: string;
  actor_name: string | null; text: string; emoji: string | null; case_id: string | null; escalation_id: string | null; op: string; status: string;
}
interface Thread { key: string; space_key: string | null; case_id: string | null; first_ts: string; last_ts: string; count: number; participants: string[]; items: Activity[] }
interface Space { key: string; name: string; configured: boolean; external: boolean; inbound: number; outbound: number; queued: number; held: number; last: string | null }

const STATUS_TONE: Record<string, "zinc" | "rose" | "amber" | "emerald" | "blue"> = { held: "rose", queued: "amber", failed: "rose", delivered: "emerald", returned: "emerald", received: "blue" };

export default function ChatSpacesPage() {
  const [hours, setHours] = useState(24);
  const [space, setSpace] = useState("");
  const [direction, setDirection] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const spaces = useApi<{ spaces: Space[]; tracked: number }>("/chat/spaces", { hours }, 30_000);
  const activity = useApi<{ items: Activity[]; threads: Thread[] }>("/chat/activity", { hours, space, direction, q }, 20_000);

  return (
    <div>
      <PageHeader title="Chat spaces"
        actions={<>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" aria-label="Search messages" className="w-full sm:w-52" />
          <Select value={direction} onChange={(e) => setDirection(e.target.value)} aria-label="Direction" className="w-auto">
            <option value="">In and out</option><option value="inbound">Received</option><option value="outbound">Sent by the agent</option>
          </Select>
          <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: 6, label: "6 h" }, { value: 24, label: "24 h" }, { value: 72, label: "3 days" }, { value: 168, label: "7 days" }]} />
        </>} />
      <ErrorState error={spaces.error || activity.error} onRetry={() => { spaces.reload(); activity.reload(); }} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {(spaces.data?.spaces ?? []).map((s) => (
          <button key={s.key} type="button" onClick={() => setSpace(space === s.key ? "" : s.key)} aria-pressed={space === s.key}
            className={cx("rounded-2xl border p-4 text-left transition-colors", space === s.key ? "border-blue-400 bg-blue-50/60 dark:border-blue-300/60 dark:bg-blue-200/10" : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/60",
              s.held > 0 && space !== s.key && "glow border-transparent dark:border-transparent")}>
            <p className="flex items-center gap-2 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.name}{s.external && <Badge tone="amber">external</Badge>}</p>
            <p className="mt-2 text-2xl font-medium tabular-nums">{s.inbound}<span className="mx-1.5 text-base text-zinc-400">in</span>{s.outbound}<span className="ml-1.5 text-base text-zinc-400">out</span></p>
            <p className="mt-1 truncate text-xs text-zinc-500">
              {!s.configured ? "Not set up in Settings" : s.held ? `${s.held} held by a safety check` : s.queued ? `${s.queued} waiting to post` : s.last ? `last ${fmtRelative(s.last)}` : "quiet"}
            </p>
          </button>
        ))}
      </div>

      <Card className="mt-5" padded={false} title={space ? `Conversations in ${spaces.data?.spaces.find((s) => s.key === space)?.name ?? space}` : "Conversations"}
        subtitle={activity.data ? `${activity.data.items.length} messages and reactions` : undefined}>
        {activity.loading && !activity.data ? <Spinner /> : !activity.data?.threads.length ? (
          <EmptyState icon={<MessagesSquare className="size-8" />} title="No Chat activity in this window">Messages the agent receives and everything it posts are listed here.</EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {activity.data.threads.map((t) => {
              const last = t.items[t.items.length - 1];
              const expanded = open === t.key;
              return (
                <li key={t.key}>
                  <button type="button" onClick={() => setOpen(expanded ? null : t.key)} aria-expanded={expanded} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <span className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-zinc-500">{fmtTime(t.last_ts)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <span className="font-medium text-zinc-800 dark:text-zinc-200">{t.space_key ?? "unknown space"}</span>
                        {t.case_id && <Badge tone="blue">{t.case_id}</Badge>}<span>{t.count} {t.count === 1 ? "item" : "items"}</span><span className="truncate">{t.participants.join(", ")}</span>
                        {t.items.some((i) => i.status === "held") && <Badge tone="rose">held</Badge>}
                      </span>
                      <span className="mt-1 line-clamp-2 block whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300">{last.kind === "reaction" ? `Reaction ${last.emoji ?? ""}` : last.text}</span>
                    </span>
                  </button>
                  {expanded && (
                    <ol className="space-y-3 border-t border-zinc-100 bg-zinc-50/60 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950/40">
                      {t.items.map((m) => (
                        <li key={m.activity_id} className={cx("max-w-3xl rounded-2xl px-4 py-2.5 text-sm", m.direction === "outbound" ? "ml-auto bg-blue-100 text-blue-950 dark:bg-blue-200/15 dark:text-blue-50" : "bg-white dark:bg-zinc-900")}>
                          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <span className="font-medium">{m.direction === "outbound" ? "Agent" : m.actor_name || m.actor}</span><span>{fmtDateTime(m.ts)}</span><span>{m.kind}</span>
                            <Badge tone={STATUS_TONE[m.status] ?? "zinc"}>{m.status}</Badge>
                            {m.link && <a href={m.link} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-200">Open in Chat</a>}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words">{m.kind === "reaction" ? `Reaction ${m.emoji ?? ""}` : m.text}</p>
                        </li>
                      ))}
                      {t.case_id && <li><Link to={`/feed/${t.case_id}`} className="text-sm font-medium text-blue-600 dark:text-blue-200">Open {t.case_id} in the review feed</Link></li>}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
