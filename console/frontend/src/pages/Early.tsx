import { Play, Thermometer } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { apiSend } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { TimeCell } from "../components/common";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Input, OffNotice, PageHeader, Spinner, Tabs } from "../components/ui";
import { useApp } from "../context";
import { fmtTime } from "../lib/format";

interface Post { url: string; platform: string; author: string; text: string; posted: string }
interface Scores { about: number; risk: number; independent: number; noise: number; category: string; severity: number; level: number; confidence: number }
interface Review { headline: string; call: "escalate" | "monitor" | "dismiss"; severity: string; story: string; why: string;
  exposure_tag: string; next_steps: string[]; temp_check_query: string }
interface Signal {
  id: string; kind: "story" | "update" | "early"; raised: string; accounts: number; posts: number; platforms: string[];
  first_posted: string; last_posted: string; items: Post[]; decisions: Scores | null; held_why: string; review: Review | null;
  status: string; by: string; note: string;
}
interface Source { key: string; label: string; status: string; error: string; how?: string; at: string }
interface Early {
  signals: Signal[]; can_act: boolean; can_run: boolean;
  state: { on: boolean; scoring: boolean; last: string; error: string; raised_today: number; sources: Source[]; named_sources: string[]; interval_minutes: number };
}

type Tab = "new" | "queued" | "acted" | "held" | "dismissed";
const IN_TAB: Record<Tab, string[]> = { new: ["new"], queued: ["queued", "failed"], acted: ["acknowledged", "escalated"], held: ["held"], dismissed: ["dismissed"] };
const KIND: Record<Signal["kind"], string> = { story: "New story", update: "Update", early: "Early signal" };
const SEVERITY_TONE: Record<string, "zinc" | "amber" | "rose" | "blue"> = { none: "zinc", low: "zinc", medium: "amber", high: "rose", critical: "rose" };
const SCORES: { key: "about" | "risk" | "independent" | "noise"; label: string }[] = [
  { key: "about", label: "About the company" }, { key: "risk", label: "A risk to the brand" },
  { key: "independent", label: "First-hand, separate accounts" }, { key: "noise", label: "Routine chatter" },
];

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-2 text-xs text-zinc-500"><span className="truncate">{label}</span><span>{Math.round(value * 100)}%</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
        <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

function Story({ signal, canAct, onDone }: { signal: Signal; canAct: boolean; onDone: (message: string) => void }) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const act = useAction((action: string) => apiSend("post", `/early/${signal.id}/action`, { action, note }));
  const go = async (action: string, message: string) => { if (await act.run(action)) onDone(message); };
  const r = signal.review;
  const posts = open ? signal.items : signal.items.slice(0, 3);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={signal.kind === "early" ? "blue" : "zinc"}>{KIND[signal.kind]}</Badge>
        {r && <Badge tone={r.call === "escalate" ? "rose" : r.call === "monitor" ? "amber" : "zinc"}>{r.call === "escalate" ? "Escalate" : r.call === "monitor" ? "Monitor" : "Dismiss"}</Badge>}
        {r && <Badge tone={SEVERITY_TONE[r.severity] ?? "zinc"}>{r.severity}</Badge>}
        {r?.exposure_tag && <Badge>{r.exposure_tag}</Badge>}
        <span className="ml-auto text-sm text-zinc-500"><TimeCell value={signal.raised} /></span>
      </div>
      <h3 className="mt-3 text-lg font-medium text-zinc-900 dark:text-zinc-100">{r?.headline ?? "Waiting for its write-up"}</h3>
      <p className="mt-1 text-sm text-zinc-500">
        {signal.accounts} accounts, {signal.posts} posts on {signal.platforms.join(", ") || "one platform"}, from {fmtTime(signal.first_posted)} to {fmtTime(signal.last_posted)}
      </p>
      {r?.story && <p className="mt-3 text-sm text-zinc-800 dark:text-zinc-200">{r.story}</p>}
      {r?.why && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{r.why}</p>}
      {signal.held_why && <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">Held back: {signal.held_why}.</p>}
      {signal.status === "failed" && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{signal.note}</p>}
      {r && r.next_steps.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-300">{r.next_steps.map((s) => <li key={s}>{s}</li>)}</ul>
      )}
      {signal.decisions && (
        <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {SCORES.map((s) => <Meter key={s.key} label={s.label} value={signal.decisions![s.key]} />)}
        </div>
      )}
      <ul className="mt-4 flex flex-col gap-2">
        {posts.map((p, i) => (
          <li key={p.url + i} className="rounded-xl bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
            <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400">
              {p.platform || "Post"} · {fmtTime(p.posted)}
            </a>
            <p className="mt-1 text-zinc-700 dark:text-zinc-300">{p.text}</p>
          </li>
        ))}
      </ul>
      {signal.items.length > 3 && <button type="button" className="mt-2 text-sm font-medium text-blue-700 dark:text-blue-400" onClick={() => setOpen(!open)}>{open ? "Show fewer posts" : `Show all ${signal.items.length} posts`}</button>}
      {signal.by && <p className="mt-3 text-sm text-zinc-500">{signal.status} by {signal.by}{signal.note ? `: ${signal.note}` : ""}</p>}
      {canAct && ["new", "acknowledged"].includes(signal.status) && (
        <div className="mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the record (optional)" aria-label="Note" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" loading={act.loading} onClick={() => go("escalate", "Escalated")}>Escalate</Button>
            {signal.status === "new" && <Button onClick={() => go("acknowledge", "Acknowledged")}>Acknowledge</Button>}
            <Button onClick={() => go("dismiss", "Dismissed")}>Dismiss</Button>
            {r?.temp_check_query && (
              <Link to={`/temp-check?issue=${encodeURIComponent(r.temp_check_query)}`}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40">
                <Thermometer className="size-4" />Size it with a temp check
              </Link>
            )}
          </div>
          <ErrorState error={act.error} />
        </div>
      )}
      {canAct && ["dismissed", "held", "escalated"].includes(signal.status) && (
        <div className="mt-3"><Button size="sm" onClick={() => go("reopen", "Moved back to New")}>Move back to New</Button></div>
      )}
    </Card>
  );
}

export default function EarlyPage() {
  const { toast } = useApp();
  const [tab, setTab] = useState<Tab>("new");
  const { data, error, loading, reload } = useApi<Early>("/early", { hours: 168 }, 30_000);
  const read = useAction(() => apiSend<{ ok: boolean; error?: string; raised?: number }>("post", "/early/check"));
  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  const count = (t: Tab) => data.signals.filter((s) => IN_TAB[t].includes(s.status)).length;
  const shown = data.signals.filter((s) => IN_TAB[tab].includes(s.status));
  const failing = data.state.sources.filter((s) => s.status === "failing" && data.state.named_sources.includes(s.key));

  return (
    <div>
      <PageHeader title="Early Detection" description="Posts on one theme from small accounts, grouped into a story before anyone raises an alert."
        actions={data.can_run && data.state.on && (
          <Button icon={<Play className="size-4" />} loading={read.loading}
            onClick={async () => { const r = await read.run(); if (r) { toast(r.ok ? `Read done: ${r.raised ?? 0} raised` : r.error ?? "The read failed", r.ok ? "success" : "error"); reload(); } }}>Read now</Button>
        )} />
      {!data.state.on && <OffNotice what="Early Detection" flag="early_detection">Nothing is read while it is off.</OffNotice>}
      {data.state.on && data.state.named_sources.length === 0 && (
        <Alert tone="amber" className="mb-4" title="No post table is named">Name the tables to read under <Link className="font-medium underline" to="/settings/early">Settings, Early Detection</Link>.</Alert>
      )}
      {failing.map((s) => <Alert key={s.key} tone="rose" className="mb-4" title={`${s.label} could not be read`}>{s.error}</Alert>)}
      {data.state.error && failing.length === 0 && <Alert tone="rose" className="mb-4" title="The last read failed">{data.state.error}</Alert>}
      <ErrorState error={read.error} />
      {data.state.on && (
        <p className="mb-4 text-sm text-zinc-500">
          Reads every {data.state.interval_minutes} minutes. Last read {data.state.last ? <TimeCell value={data.state.last} /> : "not yet"}. {data.state.raised_today} raised today.
          {" "}<Link className="font-medium text-blue-700 dark:text-blue-400" to="/ai">How it works</Link>
        </p>
      )}
      <div className="mb-4">
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[
          { key: "new", label: "New", count: count("new") }, { key: "queued", label: "Waiting for write-up", count: count("queued") },
          { key: "acted", label: "Acted on", count: count("acted") }, { key: "held", label: "Held back", count: count("held") },
          { key: "dismissed", label: "Dismissed", count: count("dismissed") }]} />
      </div>
      {shown.length === 0 ? (
        <EmptyState title={tab === "new" ? "No new stories" : "Nothing here"}>
          {tab === "new" ? "A story shows here when enough separate accounts post the same thing." : "Stories from the last 7 days show here."}
        </EmptyState>
      ) : (
        <div className={cx("grid gap-4", shown.length > 1 && "xl:grid-cols-2")}>
          {shown.map((s) => <Story key={s.id} signal={s} canAct={data.can_act} onDone={(message) => { toast(message, "success"); reload(); }} />)}
        </div>
      )}
    </div>
  );
}
