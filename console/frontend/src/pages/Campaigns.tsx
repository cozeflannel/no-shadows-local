import { Megaphone, Play, Plus, Radar, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, Modal, OffNotice, PageHeader, Select, Spinner, Stat, Tabs, TD, TH, TR, Textarea, Toggle } from "../components/ui";
import { useApp } from "../context";
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

type Tab = "campaigns" | "watches" | "detections";
type Campaign = Record<string, any>;
interface CampaignList { campaigns: Campaign[]; requests: { request_id: string; campaign_id: string; changes: Record<string, string>; requested_by: string; requested_at: string; status: string; result: string }[]; error: string; can_change: boolean; switch: boolean; editable: string[]; actions: string[] }
interface Watch { watch_id: string; name: string; enabled: boolean; question: string; rubric: string; topics: string[]; flag_at_score: number | null; networks: string[]; status: string; updated_by: string; updated_at: string | null }
interface Detection { detection_id: string; watch: string; seen_at: string; score: number; bar: number; at_bar: boolean; topic: string; post_url: string; platform: string; author: string; followers: number | null; engagement: number | null; summary: string; rating: string; case_id: string | null; lead_minutes: number | null }
interface Score { alerts: number; caught: number; caught_first: number; flags: number; near_misses: number; useful: number; noise: number; median_lead_min: number | null }
interface WatchList { watches: Watch[]; detections: Detection[]; scorecard: { total: Score; days: (Score & { day: string })[] }; switch: boolean; can_edit: boolean; settings: { default_bar: number; max_enabled: number; sources: string[]; post_target: string; default_topics: string[] } }

const FIELD_LABEL: Record<string, string> = { space_display_name: "Space name", end_time: "Ends (date and time)", threshold: "Engagement threshold", sentiment: "Sentiment", platforms: "Platforms", post_types: "Post types", daily_cap: "Daily cap", also_post_in_alerts_space: "Also post in the alerts space (yes or no)" };
const EMPTY_WATCH = { watch_id: "", name: "", enabled: false, question: "", rubric: "", topics: "", flag_at_score: "", networks: "" };

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
      {!c.data.switch && <OffNotice what="Changing campaigns from the Console" flag="campaigns">Campaigns are listed read-only.</OffNotice>}
      {c.data.error && <Alert tone="amber" title="The campaigns database is not reachable">{c.data.error} Set it in <Link className="font-medium underline" to="/settings/campaigns">Settings, Campaigns & watches</Link>.</Alert>}
      <Card padded={false} title="Campaigns" subtitle="Started in Chat with the campaigns bot. Change or end one here.">
        {c.data.campaigns.length === 0 ? <EmptyState icon={<Megaphone className="size-8" />} title="No campaigns" /> : (
          <div className="overflow-x-auto">
            <table className="w-full"><thead><tr><th className={TH}>Campaign</th><th className={TH}>Status</th><th className={TH}>Threshold</th><th className={TH}>Today</th><th className={TH}>Total</th><th className={TH}>Ends</th><th className={TH} /></tr></thead>
              <tbody>{c.data.campaigns.map((x) => {
                const open = String(x.status).toLowerCase() !== "closed";
                return (
                  <tr key={x.campaign_id} className={TR}>
                    <td className={TD}><span className="font-medium">{x.alert_name || x.query_name || x.campaign_id}</span>
                      <span className="block text-xs text-zinc-500">{x.campaign_id} {x.space_display_name}{x.space_uri ? <a className="ml-2 text-blue-600 dark:text-blue-200" href={x.space_uri} target="_blank" rel="noreferrer">Open space</a> : null}</span></td>
                    <td className={TD}><Badge tone={open ? "emerald" : "zinc"}>{String(x.status)}</Badge>{x.close_reason ? <span className="block text-xs text-zinc-500">{x.close_reason}</span> : null}</td>
                    <td className={cx(TD, "tabular-nums")}>{fmtNum(x.threshold)}{x.daily_cap ? <span className="block text-xs text-zinc-500">cap {x.daily_cap} a day</span> : null}</td>
                    <td className={cx(TD, "tabular-nums")}>{fmtNum(x.posted_today)} posted<span className="block text-xs text-zinc-500">{fmtNum(x.mentions_today)} seen</span></td>
                    <td className={cx(TD, "tabular-nums")}>{fmtNum(x.total_posted)} of {fmtNum(x.total_received)}</td>
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
        <Card padded={false} title="Change requests">
          <table className="w-full"><thead><tr><th className={TH}>When</th><th className={TH}>Campaign</th><th className={TH}>Change</th><th className={TH}>By</th><th className={TH}>Result</th></tr></thead>
            <tbody>{c.data.requests.slice(0, 30).map((r) => (
              <tr key={r.request_id} className={TR}><td className={TD}>{fmtDateTime(r.requested_at)}</td><td className={TD}>{r.campaign_id}</td>
                <td className={TD}>{Object.entries(r.changes).map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${v}`).join(", ")}</td><td className={TD}>{r.requested_by}</td>
                <td className={TD}><Badge tone={r.status === "applied" ? "emerald" : r.status === "pending" ? "amber" : "rose"}>{r.status}</Badge> <span className="text-xs text-zinc-500">{r.result}</span></td></tr>))}</tbody></table>
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

function WatchesTab({ show }: { show: "watches" | "detections" }) {
  const { toast } = useApp();
  const w = useApi<WatchList>("/watches", { days: 7 }, 60_000);
  const [form, setForm] = useState<typeof EMPTY_WATCH | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  if (w.loading && !w.data) return <Spinner />;
  if (w.error) return <ErrorState error={w.error} onRetry={w.reload} />;
  if (!w.data) return null;
  const d = w.data;
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    if (!form) return;
    setBusy("save"); setError(null);
    try {
      await apiSend("post", "/watches", { watch_id: form.watch_id || undefined, name: form.name, enabled: form.enabled, question: form.question, rubric: form.rubric, topics: list(form.topics), networks: list(form.networks), flag_at_score: form.flag_at_score ? Number(form.flag_at_score) : null });
      toast("Saved"); setForm(null); w.reload();
    } catch (err) { setError(err as ApiError); } finally { setBusy(""); }
  };
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast(done); w.reload(); } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const t = d.scorecard.total;
  return (
    <div className="space-y-5">
      {!d.switch && <OffNotice what="Watches" flag="watches" />}
      {d.switch && d.settings.sources.length === 0 && <Alert tone="amber" title="No table of posts is chosen for watches">Pick the tables to look in under <Link className="font-medium underline" to="/settings/campaigns">Settings, Campaigns & watches</Link>.</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Alerts, 7 days" value={fmtNum(t.alerts)} />
        <Stat label="Caught by a watch" value={fmtNum(t.caught)} hint={`${t.caught_first} before the alert`} />
        <Stat label="Median lead" value={t.median_lead_min === null ? "n/a" : `${Math.round(t.median_lead_min)} min`} hint="watch ahead of the alert" />
        <Stat label="Flags" value={fmtNum(t.flags)} hint={`${t.near_misses} near misses`} />
        <Stat label="Rated" value={`${t.useful} / ${t.noise}`} hint="useful / noise" />
      </div>
      {show === "watches" ? (
        <Card padded={false} title="Watches" subtitle={`Gemini reads new posts inside BigQuery and flags those at or over the bar. At most ${d.settings.max_enabled} on at once.`}
          actions={<>
            <Button icon={<Play className="size-4" />} disabled={!d.can_edit || !d.switch} loading={busy === "run"} onClick={() => act("run", () => apiSend("post", "/watches/run"), "Looked")}>Look now</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} disabled={!d.can_edit || !d.switch} onClick={() => { setError(null); setForm(EMPTY_WATCH); }}>New watch</Button>
          </>}>
          {d.watches.length === 0 ? <EmptyState icon={<Radar className="size-8" />} title="No watches">A watch is a question asked of every new post, such as "Is this about a harmful AI answer?"</EmptyState> : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.watches.map((x) => (
                <li key={x.watch_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{x.name} <Badge tone={x.enabled ? "emerald" : "zinc"}>{x.enabled ? "on" : "off"}</Badge></p>
                    <p className="text-xs text-zinc-500">{x.question} Flags at {x.flag_at_score ?? d.settings.default_bar}.{x.status ? ` ${x.status}` : ""}</p>
                  </div>
                  <Button size="sm" disabled={!d.can_edit} onClick={() => { setError(null); setForm({ watch_id: x.watch_id, name: x.name, enabled: x.enabled, question: x.question, rubric: x.rubric, topics: x.topics.join(", "), flag_at_score: x.flag_at_score ? String(x.flag_at_score) : "", networks: x.networks.join(", ") }); }}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={!d.can_edit} loading={busy === x.watch_id}
                    onClick={() => { if (window.confirm(`Delete the watch "${x.name}"?`)) void act(x.watch_id, () => apiSend("delete", `/watches/${x.watch_id}`), "Deleted"); }}>Delete</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card padded={false} title="What the watches found" subtitle="Last 7 days. Rate each one so the scorecard shows whether a watch earns its keep.">
          {d.detections.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-500">Nothing found yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full"><thead><tr><th className={TH}>Post</th><th className={TH}>Watch</th><th className={TH}>Score</th><th className={TH}>Reach</th><th className={TH}>Alert</th><th className={TH}>Rating</th></tr></thead>
                <tbody>{d.detections.map((x) => (
                  <tr key={x.detection_id} className={TR}>
                    <td className={cx(TD, "max-w-md")}><a href={x.post_url} target="_blank" rel="noreferrer" className="line-clamp-2 text-blue-600 hover:underline dark:text-blue-200">{x.summary || x.post_url}</a><span className="text-xs text-zinc-500">{x.author} on {x.platform}, seen {fmtRelative(x.seen_at)}</span></td>
                    <td className={TD}>{x.watch}<span className="block text-xs text-zinc-500">{x.topic}</span></td>
                    <td className={TD}><Badge tone={x.at_bar ? "rose" : "amber"}>{x.score} of {x.bar}</Badge></td>
                    <td className={cx(TD, "tabular-nums")}>{fmtCompact(x.followers)} followers<span className="block text-xs text-zinc-500">{fmtCompact(x.engagement)} engagement</span></td>
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
      <Modal open={!!form} wide title={form?.watch_id ? "Edit watch" : "New watch"} onClose={() => setForm(null)}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={busy === "save"} disabled={!form?.name.trim() || !form.question.trim()} onClick={save}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorState error={error} />
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Question asked of every post" hint="A yes or no question."><Textarea rows={2} className="font-sans text-sm" value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} /></Field>
            <Field label="How to score impact from 1 to 10" hint="Leave empty for the standard rubric."><Textarea rows={3} className="font-sans text-sm" value={form.rubric} onChange={(e) => setForm({ ...form, rubric: e.target.value })} /></Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Topics" hint={`Comma separated. Empty: ${d.settings.default_topics.join(", ") || "none"}`}><Input value={form.topics} onChange={(e) => setForm({ ...form, topics: e.target.value })} /></Field>
              <Field label="Networks" hint="Comma separated. Empty: all."><Input value={form.networks} onChange={(e) => setForm({ ...form, networks: e.target.value })} /></Field>
              <Field label="Flag at score" hint={`Empty: ${d.settings.default_bar}`}><Input type="number" min={1} max={10} step="0.5" value={form.flag_at_score} onChange={(e) => setForm({ ...form, flag_at_score: e.target.value })} /></Field>
            </div>
            <Toggle label="On" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function CampaignsPage() {
  const [search, setSearch] = useSearchParams();
  const tab = (search.get("tab") as Tab) || "campaigns";
  return (
    <div>
      <PageHeader title="Campaigns & watches" />
      <Tabs<Tab> value={tab} onChange={(t) => setSearch(t === "campaigns" ? {} : { tab: t }, { replace: true })}
        tabs={[{ key: "campaigns", label: "Campaigns" }, { key: "watches", label: "Watches" }, { key: "detections", label: "Found posts" }]} />
      {tab === "campaigns" ? <CampaignsTab /> : <WatchesTab show={tab} />}
    </div>
  );
}
