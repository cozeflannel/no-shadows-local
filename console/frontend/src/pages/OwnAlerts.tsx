import { ExternalLink, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { TimeCell } from "../components/common";
import {
  Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, Modal, OffNotice, PageHeader, Segmented, Select, Spinner, Tabs, TD, TH, TR, Toggle,
} from "../components/ui";
import { useApp } from "../context";
import { fmtNum } from "../lib/format";

type Verdict = "TRUE_POSITIVE" | "FALSE_POSITIVE";
interface Decision {
  id: string; at: string; item_type: string; trigger: string; rule: string; section: string; severity: string; path: string; rationale: string;
  evidence: string; velocity: string; engine: string; note: string; status: "raised" | "passed"; links: string[]; kof: string; posted_to: string;
  verdict: "" | Verdict; verdict_by: string; verdict_at: string;
}
interface Source { key: string; label: string; where: string; status: string; at: string; error: string; read: number; kept: number; more: boolean }
interface Counts { read?: number; staged?: number; reviewed?: number; raised?: number; left?: number; failed?: number }
interface State {
  on: boolean; last: string; error: string; result: Counts; sources: Source[]; objects: string; interval_minutes: number;
  review: { last: string; error: string; result: Counts }; kof: { set: boolean; handles: number; error: string };
  post: { on: boolean; target: string; space: string }; severities: string[]; bigquery_admin: boolean;
}
interface Page { state: State; decisions: Decision[]; can_act: boolean; can_run: boolean; can_edit_rules: boolean; can_set_up: boolean }
interface Rule {
  rule_id: string; rule_name: string; process_doc_section: string; execution_mode: "HARD_MANDATE" | "SOFT_CANDIDATE"; target_sources: string[];
  platforms: string[]; require_kof: boolean; min_followers: number; min_engagements: number; required_keywords_any: string[];
  required_keywords_all: string[]; excluded_keywords: string[]; forced_severity: string; forced_escalation_path: string; active: boolean;
}
interface Rules { rules: Rule[]; sources: { key: string; label: string }[]; severities: string[]; paths: string[]; pending: boolean; can_edit: boolean }
interface RuleForm {
  rule_id: string; rule_name: string; process_doc_section: string; execution_mode: Rule["execution_mode"]; target_sources: string[]; platforms: string;
  require_kof: boolean; min_followers: string; min_engagements: string; any: string; all: string; none: string; forced_severity: string;
  forced_escalation_path: string; active: boolean;
}

type Tab = "raised" | "passed" | "sources" | "rules";
const TABS: Tab[] = ["raised", "passed", "sources", "rules"];
const VERDICT: Record<Verdict, string> = { TRUE_POSITIVE: "Confirmed", FALSE_POSITIVE: "False positive" };
const NEW_RULE: RuleForm = {
  rule_id: "", rule_name: "", process_doc_section: "", execution_mode: "SOFT_CANDIDATE", target_sources: [], platforms: "", require_kof: false,
  min_followers: "", min_engagements: "", any: "", all: "", none: "", forced_severity: "", forced_escalation_path: "", active: true,
};
const BETWEEN_POSTS = " || ";  // what the agent puts between two posts of a story
const words = (text: string) => text.split(",").map((x) => x.trim()).filter(Boolean);

/** Why the review looked at it, in a few words. */
function reason(d: Decision): string {
  const rule = d.rule ? `${d.rule}${d.section ? ` (${d.section})` : ""}` : "";
  if (d.trigger === "MET_IN_CODE") return rule ? `Mandatory rule: ${rule}` : "Raised by another tool in the Other alerts space";
  if (d.trigger === "FOLLOWUP_SURGE") return "A raised story that is growing again";
  if (d.item_type === "STORY") return "A story no rule covers";
  return `Rule: ${rule}`;
}

function AlertCard({ d, severities, canAct, marked, onVerdict }: {
  d: Decision; severities: string[]; canAct: boolean; marked: boolean; onVerdict: (id: string, verdict: Verdict) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const rank = severities.indexOf(d.severity);
  const give = async (verdict: Verdict) => { setBusy(verdict); await onVerdict(d.id, verdict); setBusy(""); };
  const story = d.item_type === "STORY";
  return (
    <Card className={cx(marked && "ring-2 ring-blue-500/60")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.status === "passed" ? "zinc" : rank === 0 ? "rose" : rank === 1 ? "amber" : "blue"}>{d.severity}</Badge>
        <Badge>{d.path.replace(/_/g, " ")}</Badge>
        <Badge tone="zinc">{story ? "Story" : "Post"}</Badge>
        {d.verdict && <Badge tone={d.verdict === "TRUE_POSITIVE" ? "emerald" : "amber"}>{VERDICT[d.verdict]}</Badge>}
        <span className="ml-auto text-sm text-zinc-500"><TimeCell value={d.at} /></span>
      </div>
      <p className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">{reason(d)}</p>
      {story && d.velocity && <p className="mt-1 text-sm text-zinc-500">{d.velocity}</p>}
      {story ? (
        <ul className="mt-3 flex flex-col gap-1.5 rounded-xl bg-zinc-50 p-3 text-sm text-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-200">
          {d.evidence.split(BETWEEN_POSTS).filter((x) => x.trim()).map((x, i) => <li key={i} className="border-l-2 border-zinc-300 pl-2.5 dark:border-zinc-600">{x}</li>)}
        </ul>
      ) : (
        <p className="mt-3 whitespace-pre-line rounded-xl bg-zinc-50 p-3 text-sm text-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-200">{d.evidence}</p>
      )}
      <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{d.rationale}</p>
      <p className="mt-2 text-sm text-zinc-500">
        {d.kof ? `${story ? "KOF in the story" : "KOF"}: ${d.kof}` : `${story ? "No author" : "Author not"} on the KOF list. Details removed.`}
      </p>
      {d.links.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {d.links.map((url, i) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline dark:text-blue-400">
              <ExternalLink className="size-3.5" aria-hidden />{story ? `Post ${i + 1}` : "Open the post"}
            </a>
          ))}
        </p>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        Reviewed {d.engine === "agent_runtime" ? "on the Agent Runtime" : "by the worker"}.
        {d.status === "raised" && (d.posted_to ? " Posted in Chat." : " Not posted in Chat.")}
        {d.note && ` ${d.note}`}
      </p>
      {d.verdict && <p className="mt-1 text-xs text-zinc-500">{VERDICT[d.verdict]} by {d.verdict_by}, <TimeCell value={d.verdict_at} /></p>}
      {canAct && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Button variant={d.verdict === "TRUE_POSITIVE" ? "secondary" : "primary"} loading={busy === "TRUE_POSITIVE"} disabled={d.verdict === "TRUE_POSITIVE" || !!busy}
            onClick={() => void give("TRUE_POSITIVE")}>Confirm</Button>
          <Button loading={busy === "FALSE_POSITIVE"} disabled={d.verdict === "FALSE_POSITIVE" || !!busy} onClick={() => void give("FALSE_POSITIVE")}>False positive</Button>
        </div>
      )}
    </Card>
  );
}

function SourcesTab({ state }: { state: State }) {
  return (
    <div className="space-y-4">
      <Card padded={false} title="Sources" subtitle={`Read every ${state.interval_minutes} minutes. Choose the tables on Integrations, the rest under Settings, Agent alerts.`}>
        {state.sources.length === 0 ? (
          <EmptyState title="No source is set">Open <Link className="font-medium underline" to="/connections/bigquery">Integrations</Link> and press Find and fill.</EmptyState>
        ) : (
          <table className="w-full">
            <thead><tr><th className={TH}>Source</th><th className={TH}>Last read</th><th className={TH}>Read</th><th className={TH}>Kept</th><th className={TH}>State</th></tr></thead>
            <tbody>{state.sources.map((s) => (
              <tr key={s.key} className={TR}>
                <td className={TD}>{s.label}<span className="block text-xs text-zinc-500">{s.where}</span></td>
                <td className={TD}>{s.at ? <TimeCell value={s.at} /> : "Not yet"}</td>
                <td className={cx(TD, "tabular-nums")}>{fmtNum(s.read)}</td>
                <td className={cx(TD, "tabular-nums")}>{fmtNum(s.kept)}</td>
                <td className={TD}>
                  <Badge tone={s.status === "live" ? "emerald" : s.status === "failing" ? "rose" : s.status === "waiting" ? "amber" : "zinc"}>
                    {s.status === "live" ? "Read" : s.status === "failing" ? "Failing" : s.status === "waiting" ? "Waiting for access" : "Not read yet"}
                  </Badge>
                  {s.more && <span className="ml-2 text-xs text-zinc-500">More waiting</span>}
                  {s.status === "waiting" && (
                    <span className="mt-1 block text-xs text-amber-800 dark:text-amber-300">
                      Skipped until its owners let the Console read it. The statement to send them is under <Link className="font-medium underline" to="/connections/bigquery">Integrations, BigQuery</Link>.
                    </span>
                  )}
                  {s.error && s.status !== "waiting" && <span className="mt-1 block text-xs text-rose-600 dark:text-rose-400">{s.error}</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <p className="text-sm text-zinc-500">
        KOF list: {!state.kof.set ? "no sheet is set" : state.kof.error ? `could not be read (${state.kof.error})` : `${fmtNum(state.kof.handles)} handles`}.
        {" "}<Link className="font-medium text-blue-700 dark:text-blue-400" to="/settings/own_alerts">Settings</Link>
      </p>
    </div>
  );
}

function conditions(r: Rule, labels: Record<string, string>): string {
  const parts = [
    r.required_keywords_any.length && `any of: ${r.required_keywords_any.join(", ")}`,
    r.required_keywords_all.length && `all of: ${r.required_keywords_all.join(", ")}`,
    r.excluded_keywords.length && `none of: ${r.excluded_keywords.join(", ")}`,
    r.require_kof && "KOF authors only",
    r.min_followers > 0 && `${fmtNum(r.min_followers)} followers or more`,
    r.min_engagements > 0 && `${fmtNum(r.min_engagements)} engagements or more`,
    r.target_sources.length && `from ${r.target_sources.map((k) => labels[k] ?? k).join(", ")}`,
    r.platforms.length && `on ${r.platforms.join(", ")}`,
  ];
  return parts.filter(Boolean).join("; ").replace(/^[a-z]/, (c) => c.toUpperCase());
}

function RulesTab() {
  const { toast } = useApp();
  const list = useApi<Rules>("/own/rules");
  const [form, setForm] = useState<RuleForm | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  if (list.loading && !list.data) return <Spinner />;
  if (!list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const d = list.data;
  const labels = Object.fromEntries(d.sources.map((s) => [s.key, s.label]));
  const edit = (r: Rule) => {
    setError(null);
    setForm({
      rule_id: r.rule_id, rule_name: r.rule_name, process_doc_section: r.process_doc_section, execution_mode: r.execution_mode,
      target_sources: r.target_sources, platforms: r.platforms.join(", "), require_kof: r.require_kof,
      min_followers: r.min_followers ? String(r.min_followers) : "", min_engagements: r.min_engagements ? String(r.min_engagements) : "",
      any: r.required_keywords_any.join(", "), all: r.required_keywords_all.join(", "), none: r.excluded_keywords.join(", "),
      forced_severity: r.forced_severity, forced_escalation_path: r.forced_escalation_path, active: r.active,
    });
  };
  const save = async () => {
    if (!form) return;
    setBusy("save"); setError(null);
    const body = {
      rule_name: form.rule_name, process_doc_section: form.process_doc_section, execution_mode: form.execution_mode, target_sources: form.target_sources,
      platforms: words(form.platforms), require_kof: form.require_kof, min_followers: Number(form.min_followers) || 0,
      min_engagements: Number(form.min_engagements) || 0, required_keywords_any: words(form.any), required_keywords_all: words(form.all),
      excluded_keywords: words(form.none), forced_severity: form.forced_severity, forced_escalation_path: form.forced_escalation_path, active: form.active,
    };
    try {
      await (form.rule_id ? apiSend("put", `/own/rules/${form.rule_id}`, body) : apiSend("post", "/own/rules", body));
      toast("Saved"); setForm(null); list.reload();
    } catch (err) { setError(err as ApiError); } finally { setBusy(""); }
  };
  const remove = async (r: Rule) => {
    if (!window.confirm(`Remove the rule "${r.rule_name}"?`)) return;
    setBusy(r.rule_id);
    try { await apiSend("delete", `/own/rules/${r.rule_id}`); toast("Removed"); list.reload(); } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const set = (patch: Partial<RuleForm>) => setForm((old) => (old ? { ...old, ...patch } : old));
  return (
    <div className="space-y-4">
      {d.pending && <Alert tone="blue">The rules are copied to BigQuery before the next run.</Alert>}
      <Card padded={false} title="Rules" subtitle="Each new post is checked against every rule that is on."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} disabled={!d.can_edit} onClick={() => { setError(null); setForm(NEW_RULE); }}>Add a rule</Button>}>
        {d.rules.length === 0 ? (
          <EmptyState title="No rules yet">Without a rule, posts are only grouped into stories, and a story is raised when it grows fast.</EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {d.rules.map((r) => (
              <li key={r.rule_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {r.rule_name}
                    <Badge tone={r.execution_mode === "HARD_MANDATE" ? "rose" : "blue"}>{r.execution_mode === "HARD_MANDATE" ? "Mandatory" : "Candidate"}</Badge>
                    {!r.active && <Badge tone="zinc">Off</Badge>}
                    {r.forced_severity && <Badge>{r.forced_severity}</Badge>}
                    {r.forced_escalation_path && <Badge>{r.forced_escalation_path.replace(/_/g, " ")}</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">{r.process_doc_section && `${r.process_doc_section}. `}{conditions(r, labels)}</p>
                </div>
                <Button size="sm" disabled={!d.can_edit} onClick={() => edit(r)}>Edit</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={!d.can_edit} loading={busy === r.rule_id} onClick={() => void remove(r)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal open={!!form} wide title={form?.rule_id ? "Edit rule" : "Add a rule"} onClose={() => setForm(null)}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={busy === "save"} disabled={!form?.rule_name.trim()} onClick={() => void save()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorState error={error} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name"><Input value={form.rule_name} onChange={(e) => set({ rule_name: e.target.value })} /></Field>
              <Field label="Where it is in the process document"><Input value={form.process_doc_section} onChange={(e) => set({ process_doc_section: e.target.value })} /></Field>
            </div>
            <Segmented<Rule["execution_mode"]> label="Kind" value={form.execution_mode} onChange={(v) => set({ execution_mode: v })}
              options={[{ value: "SOFT_CANDIDATE", label: "Candidate: Gemini reads the post first" }, { value: "HARD_MANDATE", label: "Mandatory: always raised" }]} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Any of these words" hint="Comma separated."><Input value={form.any} onChange={(e) => set({ any: e.target.value })} /></Field>
              <Field label="All of these words" hint="Comma separated."><Input value={form.all} onChange={(e) => set({ all: e.target.value })} /></Field>
              <Field label="None of these words" hint="Comma separated."><Input value={form.none} onChange={(e) => set({ none: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Followers, at least"><Input type="number" min={0} value={form.min_followers} onChange={(e) => set({ min_followers: e.target.value })} /></Field>
              <Field label="Engagements, at least"><Input type="number" min={0} value={form.min_engagements} onChange={(e) => set({ min_engagements: e.target.value })} /></Field>
              <Field label="Platforms" hint="Comma separated. Empty: all."><Input value={form.platforms} onChange={(e) => set({ platforms: e.target.value })} /></Field>
            </div>
            {d.sources.length > 0 && (
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Sources. None ticked: all.</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {d.sources.map((s) => (
                    <Toggle key={s.key} label={s.label} checked={form.target_sources.includes(s.key)}
                      onChange={(on) => set({ target_sources: on ? [...form.target_sources, s.key] : form.target_sources.filter((k) => k !== s.key) })} />
                  ))}
                </div>
              </fieldset>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Severity">
                <Select value={form.forced_severity} onChange={(e) => set({ forced_severity: e.target.value })}>
                  <option value="">The review decides</option>{d.severities.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </Field>
              <Field label="Goes to">
                <Select value={form.forced_escalation_path} onChange={(e) => set({ forced_escalation_path: e.target.value })}>
                  <option value="">The review decides</option>{d.paths.map((p) => <option key={p} value={p}>{p.replace(/_/g, " ")}</option>)}
                </Select>
              </Field>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Toggle label="KOF authors only" checked={form.require_kof} onChange={(v) => set({ require_kof: v })} />
              <Toggle label="On" checked={form.active} onChange={(v) => set({ active: v })} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function OwnAlertsPage() {
  const { toast } = useApp();
  const [search, setSearch] = useSearchParams();
  const tab = TABS.includes(search.get("tab") as Tab) ? (search.get("tab") as Tab) : "raised";
  const marked = search.get("decision") ?? "";
  const { data, error, loading, reload } = useApi<Page>("/own", { days: 30 }, 30_000);
  const run = useAction(() => apiSend<{ ok: boolean; run: { error?: string; read?: number; staged?: number; waiting?: string[] }; review: { error?: string; raised?: number } }>("post", "/own/run"));
  const setup = useAction(() => apiSend<{ ok: boolean; steps: number }>("post", "/own/setup"));
  const linked = useRef(false);

  const verdict = async (id: string, value: Verdict) => {
    try {
      await apiSend("post", `/own/decisions/${id}/verdict`, { verdict: value });
      toast(VERDICT[value], "success");
      reload();
    } catch (err) { toast((err as ApiError).message, "error"); }
  };

  // A Confirm or False positive link on the alert in Chat opens this page with the alert and the verdict: it is recorded once.
  const asked = search.get("verdict");
  const canAct = data?.can_act ?? false;
  useEffect(() => {
    if (linked.current || !marked || !canAct || (asked !== "TRUE_POSITIVE" && asked !== "FALSE_POSITIVE")) return;
    linked.current = true;
    setSearch({ decision: marked }, { replace: true });
    void verdict(marked, asked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marked, asked, canAct]);

  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  const s = data.state;
  const shown = data.decisions.filter((d) => d.status === tab);
  const count = (status: Decision["status"]) => data.decisions.filter((d) => d.status === status).length;
  const failing = s.sources.filter((x) => x.status === "failing");
  const ready = s.objects === "ready";

  return (
    <div>
      <PageHeader title="Agent alerts" description="Alerts the agent raises itself from the sources it reads. Each one is reviewed before anyone is told."
        actions={data.can_run && s.on && ready && (
          <Button icon={<Play className="size-4" />} loading={run.loading}
            onClick={async () => {
              const r = await run.run();
              if (r) { toast(r.ok ? `Run done: ${r.run.staged ?? 0} posts kept, ${r.review.raised ?? 0} raised${r.run.waiting?.length ? `, ${r.run.waiting.length} waiting for access` : ""}` : r.run.error || r.review.error || "The run failed", r.ok ? "success" : "error"); reload(); }
            }}>Run now</Button>
        )} />
      {!s.on && <OffNotice what="Agent alerts" flag="own_alerts">Nothing is read or reviewed while it is off.</OffNotice>}
      {!ready && (
        <Alert tone="amber" className="mb-4" title={s.objects === "not created" ? "Its tables in BigQuery are not created yet" : "It is not set up yet"}>
          {s.objects !== "not created" && <p>{s.objects}</p>}
          {s.objects === "not created" && !s.bigquery_admin && <p>An admin turns on Change BigQuery from here under <Link className="font-medium underline" to="/settings/flags">Settings, Switches</Link> first.</p>}
          {s.objects !== "not created" && <p><Link className="font-medium underline" to="/settings/own_alerts">Settings, Agent alerts</Link></p>}
          {s.objects === "not created" && data.can_set_up && s.bigquery_admin && (
            <Button size="sm" className="mt-2" loading={setup.loading}
              onClick={async () => { const r = await setup.run(); if (r) { toast(`Created: ${r.steps} steps`, "success"); reload(); } }}>Create the tables</Button>
          )}
        </Alert>
      )}
      <ErrorState error={setup.error} />
      <ErrorState error={run.error} />
      {failing.map((x) => <Alert key={x.key} tone="rose" className="mb-4" title={`${x.label} could not be read`}>{x.error}</Alert>)}
      {s.error && failing.length === 0 && <Alert tone="rose" className="mb-4" title="The last run failed">{s.error}</Alert>}
      {s.review.error && <Alert tone="rose" className="mb-4" title="The last review failed">{s.review.error}</Alert>}
      {s.on && (
        <p className="mb-4 text-sm text-zinc-500">
          Last run {s.last ? <TimeCell value={s.last} /> : "not yet"}{s.last && `: ${fmtNum(s.result.read ?? 0)} read, ${fmtNum(s.result.staged ?? 0)} kept`}.
          {" "}Last review {s.review.last ? <TimeCell value={s.review.last} /> : "not yet"}
          {(s.review.result.left ?? 0) > 0 && `, ${fmtNum(s.review.result.left)} left for the next minute`}.
          {" "}{s.post.on && s.post.space ? `Alerts are posted in ${s.post.space}.` : <>Alerts are not posted in Chat. <Link className="font-medium text-blue-700 dark:text-blue-400" to="/settings/own_alerts">Settings</Link></>}
        </p>
      )}
      <Tabs<Tab> value={tab} onChange={(t) => setSearch(t === "raised" ? {} : { tab: t }, { replace: true })}
        tabs={[{ key: "raised", label: "Raised", count: count("raised") }, { key: "passed", label: "Passed over", count: count("passed") },
          { key: "sources", label: "Sources" }, { key: "rules", label: "Rules" }]} />
      {tab === "sources" ? <SourcesTab state={s} /> : tab === "rules" ? <RulesTab /> : shown.length === 0 ? (
        <EmptyState title={tab === "raised" ? "No alerts raised" : "Nothing passed over"}>The last 30 days show here.</EmptyState>
      ) : (
        <div className={cx("grid gap-4", shown.length > 1 && "xl:grid-cols-2")}>
          {shown.map((d) => <AlertCard key={d.id} d={d} severities={s.severities} canAct={data.can_act} marked={d.id === marked} onVerdict={verdict} />)}
        </div>
      )}
    </div>
  );
}
