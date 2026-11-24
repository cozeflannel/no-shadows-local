import { Play, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { apiSend, type ApiError } from "../../api/client";
import { useAction, useApi } from "../../api/hooks";
import { TimeCell } from "../../components/common";
import {
  Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, Modal, OffNotice, Segmented, Select, Spinner, TD, TH, TR, Toggle,
} from "../../components/ui";
import { useApp } from "../../context";
import { fmtNum } from "../../lib/format";

// What the chatbot alerts on by itself is decided here: the sources it reads and the rules it reads them by. Both used to be
// tabs of the Agent alerts page; the alerts themselves are now a view of the Review feed.

/** What went wrong, in plain words (triage_agent/ownalerts/plain.py). `technical` holds Google's own words, for admins only. */
interface Problem { kind: string; title: string; message: string; action: string; link: { to?: string; label?: string }; technical?: string }
interface Source { key: string; label: string; where: string; status: string; at: string; error: string; read: number; kept: number; more: boolean; problem?: Problem }
interface Counts { read?: number; staged?: number; reviewed?: number; raised?: number; left?: number; failed?: number }
interface State {
  on: boolean; last: string; error: string; problem?: Problem; result: Counts; sources: Source[]; objects: string; interval_minutes: number;
  review: { last: string; error: string; result: Counts; problem?: Problem }; kof: { set: boolean; handles: number; error: string; problem?: Problem };
  post: { on: boolean; target: string; space: string }; severities: string[]; bigquery_admin: boolean; made_before?: boolean;
}
interface Page { state: State; can_act: boolean; can_run: boolean; can_edit_rules: boolean; can_set_up: boolean }
interface RunAnswer { ok: boolean; run: { error?: string; read?: number; staged?: number; waiting?: string[] }; review: { error?: string; raised?: number }; problem?: Problem }
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

const NEW_RULE: RuleForm = {
  rule_id: "", rule_name: "", process_doc_section: "", execution_mode: "SOFT_CANDIDATE", target_sources: [], platforms: "", require_kof: false,
  min_followers: "", min_engagements: "", any: "", all: "", none: "", forced_severity: "", forced_escalation_path: "", active: true,
};
// Problems where nothing is broken: the agent waits, or a person sets something. They are shown in blue, not red.
const CALM = new Set(["setup", "sources", "quota", "timeout", "unavailable"]);
const words = (text: string) => text.split(",").map((x) => x.trim()).filter(Boolean);
/** Who an alert goes to, as words: BRAND_SOCIAL -> Brand Social, PR_COMMS -> PR Comms. */
const pathLabel = (path: string) => path.split("_").filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(" ");


function Intro({ children }: { children: ReactNode }) {
  return <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">{children}</p>;
}

/** What went wrong and what to do. Google's own words are folded away under Technical details, for admins. */
function ProblemAlert({ problem, title, admin }: { problem: Problem; title?: string; admin: boolean }) {
  return (
    <Alert tone={CALM.has(problem.kind) ? "blue" : "rose"} className="mb-4" title={title ?? problem.title}>
      <p>{problem.message}</p>
      {(problem.action || problem.link?.to) && (
        <p className="mt-1">
          {problem.action}
          {problem.link?.to && <>{" "}<Link className="font-medium underline" to={problem.link.to}>Open {problem.link.label}</Link></>}
        </p>
      )}
      {admin && problem.technical && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-xs font-medium">Technical details (for admins)</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/70 p-2 font-mono text-[11px] leading-relaxed text-zinc-700 dark:bg-zinc-950/50 dark:text-zinc-300">
            {problem.technical}
          </pre>
        </details>
      )}
    </Alert>
  );
}

/** What is left to set up before the agent can run, said once. */
function SetupNotice({ s, canSetUp, busy, onSetUp }: { s: State; canSetUp: boolean; busy: boolean; onSetUp: () => void }) {
  if (s.objects !== "not created") {  // a setting the agent needs is missing: the sentence says which
    return (
      <Alert tone="blue" className="mb-4" title="Agent alerts is not set up yet">
        <p>{s.objects}</p>
        <p className="mt-1"><Link className="font-medium underline" to="/settings/own_alerts">Open Reading and review</Link></p>
      </Alert>
    );
  }
  return (
    <Alert tone="blue" className="mb-4" title={s.made_before ? "Agent alerts is getting an update" : "Agent alerts is not set up yet"}>
      <p>
        {s.made_before
          ? "The tables and checks it keeps in BigQuery need updating after a change to the Console or to its settings. Nothing is lost while it waits."
          : "The tables it keeps in BigQuery have not been created yet."}
        {" "}{s.bigquery_admin
          ? "The next run does it on its own, in a few minutes."
          : <>An admin needs to turn on “Change BigQuery from here” under <Link className="font-medium underline" to="/settings/flags">Settings, Switches</Link>; the next run then does it.</>}
      </p>
      {canSetUp && s.bigquery_admin && <Button size="sm" className="mt-2" loading={busy} onClick={onSetUp}>Do it now</Button>}
    </Alert>
  );
}

function SourcesTable({ state, admin, actions }: { state: State; admin: boolean; actions?: ReactNode }) {
  const kof = state.kof;
  return (
    <div className="space-y-4">
      <Card padded={false} title="Where it reads posts" actions={actions}
        subtitle={<>Each source is read every {state.interval_minutes} minutes. Tables are chosen on <Link className="font-medium underline" to="/connections/bigquery">Integrations</Link>; how often it reads, and where a raised alert is posted, under <Link className="font-medium underline" to="/settings/own_alerts">Reading and review</Link>.</>}>
        {state.sources.length === 0 ? (
          <EmptyState title="No source is set">Open <Link className="font-medium underline" to="/connections/bigquery">Integrations</Link> and press Find and fill.</EmptyState>
        ) : (
          <table className="w-full">
            <thead><tr><th className={TH}>Source</th><th className={TH}>Last read</th><th className={TH}>Posts read</th><th className={TH}>Kept</th><th className={TH}>State</th></tr></thead>
            <tbody>{state.sources.map((s) => (
              <tr key={s.key} className={TR}>
                <td className={TD}>{s.label}<span className="block text-xs text-zinc-500">{s.where}</span></td>
                <td className={TD}>{s.at ? <TimeCell value={s.at} /> : "Not yet"}</td>
                <td className={cx(TD, "tabular-nums")}>{fmtNum(s.read)}</td>
                <td className={cx(TD, "tabular-nums")}>{fmtNum(s.kept)}</td>
                <td className={TD}>
                  <Badge tone={s.status === "live" ? "emerald" : s.status === "failing" ? "rose" : s.status === "waiting" ? "violet" : "zinc"}>
                    {s.status === "live" ? "Read" : s.status === "failing" ? "Could not read" : s.status === "waiting" ? "Waiting for access" : "Not read yet"}
                  </Badge>
                  {s.more && <span className="ml-2 text-xs text-zinc-500">More posts waiting</span>}
                  {s.status === "waiting" && (
                    <span className="mt-1 block text-xs text-violet-700 dark:text-violet-300">
                      Skipped until its owners let the Console read it. The statement to send them is under <Link className="font-medium underline" to="/connections/bigquery">Integrations, BigQuery</Link>.
                    </span>
                  )}
                  {s.status !== "waiting" && s.problem?.message && (
                    <span className="mt-1 block text-xs text-rose-600 dark:text-rose-400">
                      {s.problem.message} {s.problem.action}
                      {admin && s.problem.technical && (
                        <details className="mt-1 text-zinc-500"><summary className="cursor-pointer select-none">Technical details (for admins)</summary>
                          <span className="block whitespace-pre-wrap break-words font-mono text-[11px]">{s.problem.technical}</span></details>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <p className="text-sm text-zinc-500">
        KOF list: {!kof.set ? "no sheet is set, so no author counts as a KOF" : kof.problem?.message ? `it could not be read just now. ${kof.problem.message}` : `${fmtNum(kof.handles)} handles`}.
        {" "}<Link className="font-medium text-blue-700 dark:text-blue-400" to="/settings/own_alerts">Set the KOF sheet</Link>
      </p>
    </div>
  );
}

/** Settings, Agent alerts, Sources: where the agent reads posts to raise alerts of its own, how each read went, and a run by hand. */
export function OwnSourcesPanel() {
  const { toast } = useApp();
  const { data, error, loading, reload } = useApi<Page>("/own", { days: 1 }, 30_000);
  const run = useAction(() => apiSend<RunAnswer>("post", "/own/run"));
  const setup = useAction(() => apiSend<{ ok: boolean; steps: number }>("post", "/own/setup"));
  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  const s = data.state;
  const admin = data.can_set_up;
  const failing = s.sources.filter((x) => x.status === "failing");
  const ready = s.objects === "ready";
  const runNow = async () => {
    const r = await run.run();
    if (!r) return;
    const waiting = r.run.waiting?.length ? `, ${r.run.waiting.length} source${r.run.waiting.length === 1 ? "" : "s"} waiting for access` : "";
    toast(r.ok ? `Run finished: ${fmtNum(r.run.staged ?? 0)} new posts kept, ${fmtNum(r.review.raised ?? 0)} alerts raised${waiting}`
      : r.problem?.title ? `${r.problem.title}. ${r.problem.message}` : "The run did not finish. Press Run now to try again.", r.ok ? "success" : "error");
    reload();
  };
  return (
    <div className="space-y-4">
      <Intro>
        The chatbot raises alerts of its own from the posts it reads here, checked against the{" "}
        <Link className="font-medium text-blue-700 hover:underline dark:text-blue-300" to="/settings/own-rules">rules</Link>. The alerts it raises, and what it
        looked at and did not raise, are in the <Link className="font-medium text-blue-700 hover:underline dark:text-blue-300" to="/feed?kind=agent">Review feed</Link>.
      </Intro>
      {!s.on && <OffNotice what="Agent alerts" flag="own_alerts">Nothing is read or checked while it is off.</OffNotice>}
      {!ready && (
        <SetupNotice s={s} canSetUp={data.can_set_up} busy={setup.loading}
          onSetUp={async () => { const r = await setup.run(); if (r) { toast("Agent alerts is set up", "success"); reload(); } }} />
      )}
      <ErrorState error={setup.error} />
      <ErrorState error={run.error} />
      {failing.map((x) => x.problem?.message && <ProblemAlert key={x.key} title={`${x.label} could not be read`} problem={x.problem} admin={admin} />)}
      {s.problem?.message && failing.length === 0 && <ProblemAlert problem={s.problem} admin={admin} />}
      {s.review.problem?.message && <ProblemAlert problem={s.review.problem} admin={admin} />}
      {s.on && (
        <p className="text-sm text-zinc-500">
          New posts are read every {s.interval_minutes} minutes. Last read {s.last ? <TimeCell value={s.last} /> : "not yet"}
          {s.last && `: ${fmtNum(s.result.read ?? 0)} posts read, ${fmtNum(s.result.staged ?? 0)} kept`}.
          {" "}Last review {s.review.last ? <TimeCell value={s.review.last} /> : "not yet"}
          {(s.review.result.left ?? 0) > 0 && `, ${fmtNum(s.review.result.left)} left for the next minute`}.
          {" "}{s.post.on && s.post.space ? `Raised alerts are also posted in ${s.post.space}.`
            : <>Raised alerts are shown in the Review feed only, not posted in Chat. <Link className="font-medium text-blue-700 dark:text-blue-400" to="/settings/own_alerts">Change this</Link></>}
        </p>
      )}
      <SourcesTable state={s} admin={admin} actions={data.can_run && s.on && (ready || s.bigquery_admin) && (
        <Button icon={<Play className="size-4" />} loading={run.loading} onClick={() => void runNow()}>Run now</Button>
      )} />
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

/** Settings, Agent alerts, Rules: what a post must say, or who must post it, for the agent to raise an alert of its own. */
export function OwnRulesPanel() {
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
      <Intro>
        The rules decide which posts the chatbot alerts on. A mandatory rule always raises an alert; a candidate rule sends the post to Gemini, which reads it first.
        What it reads is under <Link className="font-medium text-blue-700 hover:underline dark:text-blue-300" to="/settings/own-sources">Sources</Link>.
      </Intro>
      {!d.can_edit && <Alert tone="blue" title="Read-only">Leads and admins can add, change or remove a rule.</Alert>}
      {d.pending && <Alert tone="blue">Rule changes reach the agent at its next run.</Alert>}
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
                    {r.forced_escalation_path && <Badge>{pathLabel(r.forced_escalation_path)}</Badge>}
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
                  <option value="">Gemini decides</option>{d.severities.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </Field>
              <Field label="Goes to">
                <Select value={form.forced_escalation_path} onChange={(e) => set({ forced_escalation_path: e.target.value })}>
                  <option value="">Gemini decides</option>{d.paths.map((p) => <option key={p} value={p}>{pathLabel(p)}</option>)}
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
