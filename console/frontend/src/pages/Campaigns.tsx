import { Megaphone, Pencil, Play, Plus, Radar, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { SignalImportModal } from "../components/SheetImport";
import { networkName, SignalForm, type Signal, type SignalDefaults, type SignalTemplate } from "../components/SignalForm";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, Modal, OffNotice, PageHeader, Select, Spinner, Stat, Switch, Tabs, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

type Tab = "campaigns" | "watches" | "detections";
type Campaign = Record<string, any>;
interface CampaignList { campaigns: Campaign[]; requests: { request_id: string; campaign_id: string; changes: Record<string, string>; requested_by: string; requested_at: string; status: string; result: string }[]; error: string; can_change: boolean; switch: boolean; editable: string[]; actions: string[] }
interface Detection { detection_id: string; watch: string; seen_at: string; score: number; bar: number; at_bar: boolean; topic: string; post_url: string; platform: string; author: string; followers: number | null; engagement: number | null; summary: string; rating: string; case_id: string | null; lead_minutes: number | null }
interface Score { alerts: number; caught: number; caught_first: number; flags: number; near_misses: number; useful: number; noise: number; median_lead_min: number | null }
interface WatchList { watches: Signal[]; detections: Detection[]; scorecard: { total: Score; days: (Score & { day: string })[] }; switch: boolean; can_edit: boolean; can_import: boolean; settings: { default_bar: number; max_enabled: number; sources: string[]; post_target: string; default_topics: string[] }; defaults: SignalDefaults; templates: SignalTemplate[] }

const FIELD_LABEL: Record<string, string> = { space_display_name: "Space name", end_time: "Ends (date and time)", threshold: "Engagement threshold", sentiment: "Sentiment", platforms: "Platforms", post_types: "Post types", daily_cap: "Daily cap", also_post_in_alerts_space: "Also post in the alerts space (yes or no)" };

function CampaignsTab() {
  const { toast } = useApp();
  const c = useApi<CampaignList>("/campaigns", undefined, 60_000);
  const [edit, setEdit] = useState<Campaign | null>(null);
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (c.loading && !c.data) return <Spinner />;
  if (c.error) return <ErrorState error={c.error} onRetry={c.reload} />;
  if (!c.data) return null;
  const send = async (id: string, body: Record<string, string>) => {
    setBusy(true);
    try {
      await apiSend("post", `/campaigns/${id}/changes`, { changes: body });
      toast("Requested. The campaigns service applies it within a minute."); setEdit(null); c.reload();
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-5">
      {!c.data.switch && <OffNotice what="Changing campaigns from the Console" flag="campaigns">Campaigns are shown, but can't be changed here.</OffNotice>}
      {c.data.error && <Alert tone="rose" title="The campaigns database can't be reached">{c.data.error} Set it in <Link className="font-medium underline" to="/settings/campaigns">Settings, Campaigns &amp; watches</Link>.</Alert>}
      <Card padded={false} title="Campaigns" subtitle="Started in Chat with the campaigns bot. Change one or end it here.">
        {c.data.campaigns.length === 0 ? <EmptyState icon={<Megaphone className="size-8" />} title="No campaigns">A campaign is started in Chat with the campaigns bot.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full"><thead><tr><th className={TH}>Campaign</th><th className={TH}>Status</th><th className={TH}>Threshold</th><th className={TH}>Today</th><th className={TH}>So far</th><th className={TH}>Ends</th><th className={TH} /></tr></thead>
              <tbody>{c.data.campaigns.map((x) => {
                const open = String(x.status).toLowerCase() !== "closed";
                return (
                  <tr key={x.campaign_id} className={TR}>
                    <td className={TD}><span className="font-medium">{x.alert_name || x.query_name || x.campaign_id}</span>
                      <span className="block text-xs text-zinc-500">{x.campaign_id} {x.space_display_name}{x.space_uri ? <a className="ml-2 text-blue-600 dark:text-blue-200" href={x.space_uri} target="_blank" rel="noreferrer">Open space</a> : null}</span></td>
                    <td className={TD}><Badge tone={open ? "emerald" : "zinc"}>{String(x.status)}</Badge>{x.close_reason ? <span className="block text-xs text-zinc-500">{x.close_reason}</span> : null}</td>
                    <td className={cx(TD, "tabular-nums")}>{fmtNum(x.threshold)}{x.daily_cap ? <span className="block text-xs text-zinc-500">at most {x.daily_cap} a day</span> : null}</td>
                    <td className={cx(TD, "tabular-nums")}>{fmtNum(x.posted_today)} posted<span className="block text-xs text-zinc-500">{fmtNum(x.mentions_today)} seen</span></td>
                    <td className={cx(TD, "tabular-nums")}>{fmtNum(x.total_posted)} posted of {fmtNum(x.total_received)}</td>
                    <td className={TD}>{fmtDateTime(x.end_time_utc)}</td>
                    <td className={cx(TD, "whitespace-nowrap text-right")}>
                      {open && <>
                        <Button size="sm" disabled={!c.data!.can_change} onClick={() => { setEdit(x); setChanges({}); }}>Change</Button>{" "}
                        <Button size="sm" variant="danger" disabled={!c.data!.can_change || busy} onClick={() => { if (window.confirm(`End ${x.alert_name || x.campaign_id} now?`)) void send(x.campaign_id, { action: c.data!.actions[0] }); }}>End now</Button>
                      </>}
                    </td>
                  </tr>);
              })}</tbody></table>
          </div>
        )}
      </Card>
      {c.data.requests.length > 0 && (
        <Card padded={false} title="Change requests" subtitle="What was asked of the campaigns service, and what it did.">
          <table className="w-full"><thead><tr><th className={TH}>When</th><th className={TH}>Campaign</th><th className={TH}>Change</th><th className={TH}>By</th><th className={TH}>Result</th></tr></thead>
            <tbody>{c.data.requests.slice(0, 30).map((r) => (
              <tr key={r.request_id} className={TR}><td className={TD}>{fmtDateTime(r.requested_at)}</td><td className={TD}>{r.campaign_id}</td>
                <td className={TD}>{Object.entries(r.changes).map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${v}`).join(", ")}</td><td className={TD}>{r.requested_by}</td>
                <td className={TD}><Badge tone={r.status === "applied" ? "emerald" : r.status === "pending" ? "blue" : "rose"}>{r.status}</Badge> <span className="text-xs text-zinc-500">{r.result}</span></td></tr>))}</tbody></table>
        </Card>
      )}
      <Modal open={!!edit} title={`Change ${edit?.alert_name || edit?.campaign_id || ""}`} onClose={() => setEdit(null)}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!Object.values(changes).some((v) => v.trim())} onClick={() => edit && send(edit.campaign_id, Object.fromEntries(Object.entries(changes).filter(([, v]) => v.trim())))}>Request change</Button></>}>
        <p className="mb-3 text-sm text-zinc-500">Fill in only what should change.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {c.data.editable.filter((k) => k !== "action").map((k) => {
            const current = edit ? (k === "end_time" ? edit.end_time_utc : k === "sentiment" ? edit.sentiments : edit[k]) : "";
            return <Field key={k} label={FIELD_LABEL[k] ?? k} hint={`Now: ${Array.isArray(current) ? current.join(", ") || "any" : String(current ?? "")}`}><Input value={changes[k] ?? ""} onChange={(e) => setChanges({ ...changes, [k]: e.target.value })} /></Field>;
          })}
        </div>
      </Modal>
    </div>
  );
}

function SignalRow({ x, d, busy, onEdit, onToggle, onDelete }: { x: Signal; d: WatchList; busy: string; onEdit: () => void; onToggle: (on: boolean) => void; onDelete: () => void }) {
  const flag = x.flag_at_score ?? d.settings.default_bar;
  return (
    <li className="flex flex-wrap items-start gap-4 px-5 py-4">
      <div className="pt-0.5"><Switch label={`${x.name}: ${x.enabled ? "on" : "off"}`} checked={x.enabled} disabled={!d.can_edit || busy === `s-${x.watch_id}`} onChange={onToggle} /></div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {x.name}
          <Badge tone={x.enabled ? (x.checked ? "emerald" : "blue") : "zinc"}>{x.enabled ? (x.checked ? "On, checked" : "On") : "Off"}</Badge>
          {x.imported_from === "sheet" && <Badge tone="zinc">From the sheet{x.sheet_on ? ", on there" : ""}</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">{x.plain_status}</p>
        <p className="mt-1 line-clamp-2 text-sm text-zinc-700 dark:text-zinc-300" title={x.question}>{x.question}</p>
        <p className="mt-1 text-xs text-zinc-500">
          Flags at {flag} of 10 · Topics: {x.topics.length ? x.topics.join(", ") : d.settings.default_topics.join(", ") || "none"} · Networks: {x.networks.length ? x.networks.map(networkName).join(", ") : "all"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" icon={<Pencil className="size-3.5" />} disabled={!d.can_edit} onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={!d.can_edit} loading={busy === `d-${x.watch_id}`} onClick={onDelete}>Delete</Button>
      </div>
    </li>
  );
}

function SignalsTab({ show }: { show: "watches" | "detections" }) {
  const { toast } = useApp();
  const w = useApi<WatchList>("/watches", { days: 7 }, 60_000);
  const [form, setForm] = useState<{ signal: Signal | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState("");
  if (w.loading && !w.data) return <Spinner />;
  if (w.error) return <ErrorState error={w.error} onRetry={w.reload} />;
  if (!w.data) return null;
  const d = w.data;
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast(done); w.reload(); } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const t = d.scorecard.total;
  const onCount = d.watches.filter((x) => x.enabled).length;
  const max = d.settings.max_enabled;
  return (
    <div className="space-y-5">
      {!d.switch && (
        <OffNotice what="Checking new posts against your signals" flag="watches">
          You can still add, change, turn on or off and delete signals here: the switch only decides whether the Console looks at new posts.
        </OffNotice>
      )}
      {d.switch && d.settings.sources.length === 0 && <Alert tone="blue" title="No table of posts is chosen for signals">Pick the tables to look in under <Link className="font-medium underline" to="/settings/campaigns">Settings, Campaigns &amp; watches</Link>.</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Alerts, last 7 days" value={fmtNum(t.alerts)} />
        <Stat label="Caught by a signal" value={fmtNum(t.caught)} hint={`${t.caught_first} before the alert came in`} />
        <Stat label="Median head start" value={t.median_lead_min === null ? "n/a" : `${Math.round(t.median_lead_min)} min`} hint="a signal ahead of the alert" />
        <Stat label="Flagged" value={fmtNum(t.flags)} hint={`${t.near_misses} near misses`} />
        <Stat label="Rated useful / noise" value={`${t.useful} / ${t.noise}`} hint="your ratings of found posts" />
      </div>
      {show === "watches" ? (
        <Card padded={false} title="Signals (watches)"
          subtitle="A signal is a yes/no question Gemini asks of every new post, as on the sheet's Watches tab. Posts that match are scored 1 to 10 for impact, and those at the signal's flag score or above are flagged."
          actions={<>
            <Button icon={<Play className="size-4" />} disabled={!d.can_edit || !d.switch} title={d.switch ? "Look at new posts now" : "Turn on the Watches switch to look at new posts"} loading={busy === "run"} onClick={() => act("run", () => apiSend("post", "/watches/run"), "Looked at new posts")}>Look now</Button>
            {d.can_import && <Button onClick={() => setImporting(true)}>Bring over the sheet's signals</Button>}
            <Button variant="primary" icon={<Plus className="size-4" />} disabled={!d.can_edit} onClick={() => setForm({ signal: null })}>New signal</Button>
          </>}>
          <p className="border-b border-zinc-100 px-5 py-2.5 text-xs text-zinc-500 dark:border-zinc-800">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">{onCount} of {max} on.</span> At most {max} signals can be on at once, because each one is a question Gemini asks of every new post. Turn one off to turn another on.
          </p>
          {d.watches.length === 0 ? <EmptyState icon={<Radar className="size-8" />} title="No signals yet">Click New signal, or bring over the sheet's signals. A signal is a question such as “Does this post claim a Gemini answer was harmful?”</EmptyState> : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.watches.map((x) => (
                <SignalRow key={x.watch_id} x={x} d={d} busy={busy} onEdit={() => setForm({ signal: x })}
                  onToggle={(on) => act(`s-${x.watch_id}`, () => apiSend("post", `/watches/${x.watch_id}/switch`, { enabled: on }), on ? `“${x.name}” is on` : `“${x.name}” is off`)}
                  onDelete={() => { if (window.confirm(`Delete the signal “${x.name}”? What it found stays under Found posts.`)) void act(`d-${x.watch_id}`, () => apiSend("delete", `/watches/${x.watch_id}`), "Signal deleted"); }} />
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card padded={false} title="What the signals found" subtitle="Last 7 days. Rate each one, so the scorecard shows whether a signal earns its keep.">
          {d.detections.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-500">Nothing found yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full"><thead><tr><th className={TH}>Post</th><th className={TH}>Signal</th><th className={TH}>Score</th><th className={TH}>Reach</th><th className={TH}>Alert</th><th className={TH}>Rating</th></tr></thead>
                <tbody>{d.detections.map((x) => (
                  <tr key={x.detection_id} className={TR}>
                    <td className={cx(TD, "max-w-md")}><a href={x.post_url} target="_blank" rel="noreferrer" className="line-clamp-2 text-blue-600 hover:underline dark:text-blue-200">{x.summary || x.post_url}</a><span className="text-xs text-zinc-500">{x.author} on {x.platform}, seen {fmtRelative(x.seen_at)}</span></td>
                    <td className={TD}>{x.watch}<span className="block text-xs text-zinc-500">{x.topic}</span></td>
                    <td className={TD}><Badge tone={x.at_bar ? "rose" : "violet"} title={x.at_bar ? "At or over the flag score: flagged" : "Just under the flag score: a near miss"}>{x.score} of {x.bar}</Badge></td>
                    <td className={cx(TD, "tabular-nums")}>{fmtCompact(x.followers)} followers<span className="block text-xs text-zinc-500">{fmtCompact(x.engagement)} engagements</span></td>
                    <td className={TD}>{x.case_id ? <><Link className="text-blue-600 dark:text-blue-200" to={`/feed/${x.case_id}`}>{x.case_id}</Link><span className="block text-xs text-zinc-500">{x.lead_minutes !== null && x.lead_minutes >= 0 ? `${Math.round(x.lead_minutes)} min ahead` : "after the alert"}</span></> : <span className="text-zinc-500">none yet</span>}</td>
                    <td className={TD}>
                      <Select value={x.rating} disabled={busy === x.detection_id} aria-label="Rating" className="w-28"
                        onChange={(e) => void act(x.detection_id, () => apiSend("post", `/watches/detections/${x.detection_id}/rating`, { rating: e.target.value }), "Rated")}>
                        <option value="">Unrated</option><option value="Useful">Useful</option><option value="Noise">Noise</option>
                      </Select>
                    </td>
                  </tr>))}</tbody></table>
            </div>
          )}
        </Card>
      )}
      <SignalForm open={!!form} signal={form?.signal ?? null} signals={d.watches} defaults={d.defaults} templates={d.templates} maxOn={max} switchOn={d.switch}
        onClose={() => setForm(null)} onSaved={w.reload} />
      <SignalImportModal open={importing} onClose={() => setImporting(false)} onDone={w.reload} />
    </div>
  );
}

export default function CampaignsPage() {
  const [search, setSearch] = useSearchParams();
  const tab = (search.get("tab") as Tab) || "campaigns";
  return (
    <div>
      <PageHeader title="Campaigns & watches" description="Brandwatch alert campaigns, and signals: yes/no questions Gemini asks of every new post, as on the sheet's Watches tab." />
      <Tabs<Tab> value={tab} onChange={(t) => setSearch(t === "campaigns" ? {} : { tab: t }, { replace: true })}
        tabs={[{ key: "campaigns", label: "Campaigns" }, { key: "watches", label: "Signals (watches)" }, { key: "detections", label: "Found posts" }]} />
      {tab === "campaigns" ? <CampaignsTab /> : <SignalsTab show={tab} />}
    </div>
  );
}
