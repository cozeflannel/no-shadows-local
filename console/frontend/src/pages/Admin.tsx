import { Check, Copy, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { Alert, Badge, Button, Card, cx, Dot, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Switch, Tabs, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";
import { fmtDateTime, fmtRelative } from "../lib/format";

interface PersonRow {
  email: string; name: string; role: string; role_source: string; on_roster: boolean; on_call: boolean; gmail_connected: boolean | null;
  last_active: string | null; actions: number;
}
interface Change { audit_id: string; ts: string; actor: string; action: string; summary: string; status: string; target_id: string }
interface Overview {
  people: PersonRow[];
  access: { viewer_domains: string[]; bootstrap_admins: string[] };
  status: {
    tick: { at: string | null; minutes_ago: number | null; ok: boolean; failed: string[]; late_after_minutes: number };
    agent: { runtime: string; model: string; backend: string; env: string; config_version: string };
    delivery: { pubsub: boolean; doorbell: string; dead_letters: number; waiting: number; oldest_waiting_min: number };
    safety: { passed: boolean; testing: boolean; checks: number; failed: { id: string; title: string; severity: string; fix: string }[] };
    bigquery: { dataset: string; connected: boolean };
    switches_on: string[]; switches: number;
  };
  changes: Change[];
  active: { actor: string; actions: number; last_at: string }[];
  events_seen: number;
}
interface Connections { summary: { required: number; ready: number; connected: number; failing: number; total: number } }

type Tab = "people" | "system" | "changes";
type SimpleRole = "admin" | "user";

function toSimpleRole(role: string): SimpleRole {
  return role === "admin" ? "admin" : "user";
}

function roleLabel(role: string): { label: string; tone: "violet" | "blue" | "zinc" } {
  if (role === "admin") return { label: "Admin", tone: "violet" };
  if (role === "viewer") return { label: "Viewer", tone: "zinc" };
  return { label: "User", tone: "blue" };
}

function QuickAddCard({ onAdded }: { onAdded: (msg: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<SimpleRole>("user");
  const [onRoster, setOnRoster] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!addr) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await apiSend<{ person: PersonRow }>("put", `/admin/people/${encodeURIComponent(addr)}`, {
        name: name.trim(),
        role,
        on_roster: onRoster,
      });
      setEmail("");
      setName("");
      setRole("user");
      setOnRoster(false);
      onAdded(`${res.person.name || addr} added as ${role === "admin" ? "Admin" : "User"}`);
    } catch (ex) {
      setErr((ex as ApiError).message || "Could not add person");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Add someone" subtitle="Give a teammate User access (reviews alerts, runs tools, asks Gemini) or Admin access (also manages People, Settings & Switches).">
      <form onSubmit={submit} className="flex flex-col gap-3">
        {err && <Alert tone="rose">{err}</Alert>}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_180px_auto]">
          <Field label="Email address">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter email address" autoComplete="off" required />
          </Field>
          <Field label="Display name (optional)">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Auto-filled from email" autoComplete="off" />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as SimpleRole)}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" icon={<UserPlus className="size-4" />} loading={saving} disabled={!email.trim()}>
              Add person
            </Button>
          </div>
        </div>
        <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={onRoster} onChange={(e) => setOnRoster(e.target.checked)} className="size-4 rounded border-zinc-300 accent-blue-600" />
          Also include on the Incident Manager shift roster
        </label>
      </form>
    </Card>
  );
}

function PersonForm({ person, onDone, onClose }: { person: PersonRow; onDone: (message: string) => void; onClose: () => void }) {
  const [name, setName] = useState(person.name || "");
  const [role, setRole] = useState<SimpleRole>(toSimpleRole(person.role));
  const [onRoster, setOnRoster] = useState(person.on_roster);
  const [confirm, setConfirm] = useState(false);
  const save = useAction(() => apiSend("put", `/admin/people/${encodeURIComponent(person.email)}`, { name: name.trim(), role, on_roster: onRoster }));
  const remove = useAction(() => apiSend("delete", `/admin/people/${encodeURIComponent(person.email)}`));
  const error = save.error ?? remove.error;

  return (
    <Modal open onClose={onClose} title={`Edit ${person.name || person.email}`}
      footer={confirm ? (
        <>
          <span className="mr-auto text-sm text-zinc-600 dark:text-zinc-300">Remove {person.name || person.email} from this app?</span>
          <Button onClick={() => setConfirm(false)}>Keep</Button>
          <Button variant="danger" loading={remove.loading} onClick={async () => { if (await remove.run()) onDone(`${person.name || person.email} removed`); }}>Remove</Button>
        </>
      ) : (
        <>
          <Button className="mr-auto" onClick={() => setConfirm(true)}>Remove person</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.loading} onClick={async () => { if (await save.run()) onDone(`${name.trim() || person.email} updated`); }}>Save</Button>
        </>
      )}>
      <div className="flex flex-col gap-4">
        {error && <Alert tone="rose">{error.message}</Alert>}
        <Field label="Email"><Input type="email" value={person.email} disabled /></Field>
        <Field label="Display name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></Field>
        <Field label="Role" hint={role === "admin" ? "Full access: manages People, Settings, Switches, Integrations, and works alerts." : "Standard access: reviews alerts, escalates, drafts emails, runs Temp check & Post velocity, creates signals, and asks Gemini."}>
          <Select value={role} onChange={(e) => setRole(e.target.value as SimpleRole)}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <p className="text-sm text-zinc-900 dark:text-zinc-100">On the IM shift roster</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Can hold on-call shifts in Workforce.</p>
          </div>
          <Switch label="On the IM shift roster" checked={onRoster} onChange={setOnRoster} />
        </div>
      </div>
    </Modal>
  );
}

function StatusCard({ title, ok, to, link, children }: { title: string; ok: boolean | null; to: string; link: string; children: React.ReactNode }) {
  return (
    <div className={cx("rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900", ok === false && "glow border-transparent dark:border-transparent")}>
      <p className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100"><Dot tone={ok === null ? "zinc" : ok ? "emerald" : "rose"} />{title}</p>
      <div className="mt-2 flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
      <Link to={to} className="mt-3 inline-block text-sm text-blue-700 hover:underline dark:text-blue-300">{link}</Link>
    </div>
  );
}

export default function AdminPage() {
  const { me, toast } = useApp();
  const { tab } = useParams();
  const navigate = useNavigate();
  const current: Tab = tab === "system" || tab === "changes" ? tab : "people";
  const data = useApi<Overview>("/admin/overview", undefined, 30_000);
  const tools = useApi<Connections>("/connections", undefined, 60_000);
  const [editing, setEditing] = useState<PersonRow | null>(null);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const o = data.data;
  const s = o?.status;
  const short = (resource: string) => resource.split("/").slice(-1)[0];
  const openDomain = o?.access.viewer_domains?.[0] ?? "";
  const workspaceDomain = openDomain || (me?.email.includes("@") ? me.email.split("@")[1] : "");

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      toast("App link copied to clipboard");
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      toast(window.location.origin, "info");
    }
  };

  const changeRoleInline = async (p: PersonRow, next: SimpleRole) => {
    if (toSimpleRole(p.role) === next) return;
    setBusyEmail(p.email);
    try {
      await apiSend("put", `/admin/people/${encodeURIComponent(p.email)}`, { name: p.name, role: next, on_roster: p.on_roster });
      toast(`${p.name || p.email} is now ${next === "admin" ? "an Admin" : "a User"}`);
      data.reload();
    } catch (ex) {
      toast((ex as ApiError).message || "Could not update role", "error");
    } finally {
      setBusyEmail(null);
    }
  };

  const removeInline = async (p: PersonRow) => {
    setBusyEmail(p.email);
    try {
      await apiSend("delete", `/admin/people/${encodeURIComponent(p.email)}`);
      setConfirmRemove(null);
      toast(`${p.name || p.email} removed`);
      data.reload();
    } catch (ex) {
      toast((ex as ApiError).message || "Could not remove person", "error");
    } finally {
      setBusyEmail(null);
    }
  };

  const toggleOpenViewers = async (checked: boolean) => {
    setAccessBusy(true);
    try {
      await apiSend("put", "/admin/access", { open_domain_viewers: checked, domain: workspaceDomain });
      toast(checked ? `Unlisted @${workspaceDomain} colleagues can now view read-only` : "Invite-only enabled: only people listed here can open the app");
      data.reload();
    } catch (ex) {
      toast((ex as ApiError).message || "Could not change link access mode", "error");
    } finally {
      setAccessBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="People & Admin"
        description="Manage who can open the app, set their role (User or Admin), and check system health."
        actions={(
          <Button size="sm" icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} onClick={copyLink}>
            {copied ? "Copied link" : "Copy app link"}
          </Button>
        )}
      />
      <Tabs<Tab> value={current} onChange={(t) => navigate(t === "people" ? "/admin" : `/admin/${t}`)}
        tabs={[{ key: "people", label: "People & roles", count: o?.people.length }, { key: "system", label: "System health" }, { key: "changes", label: "Recent changes" }]} />
      <ErrorState error={data.error} onRetry={data.reload} />
      {data.loading && !o ? <Spinner /> : o && s && (
        <div>
          {current === "people" && (
            <div className="flex flex-col gap-4">
              {me?.is_admin && (
                <QuickAddCard onAdded={(msg) => { toast(msg, "success"); data.reload(); }} />
              )}

              <Card title="Team members" subtitle="Users can work alerts and run every analyst tool; Admins can also manage People, Settings, and Switches." padded={false}>
                <table className="w-full min-w-[740px] border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>Person</th>
                      <th className={TH}>Role</th>
                      <th className={TH}>Shift roster</th>
                      <th className={TH}>Gmail</th>
                      <th className={TH}>Last active</th>
                      {me?.is_admin && <th className={cx(TH, "text-right")}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {o.people.map((p) => {
                      const badge = roleLabel(p.role);
                      const busy = busyEmail === p.email;
                      return (
                        <tr key={p.email} className={TR}>
                          <td className={TD}>
                            <p className="font-medium text-zinc-900 dark:text-zinc-100">{p.name || p.email.split("@")[0]}</p>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">{p.email}</p>
                          </td>
                          <td className={TD}>
                            {me?.is_admin ? (
                              <Select
                                aria-label={`Role for ${p.email}`}
                                value={toSimpleRole(p.role)}
                                disabled={busy}
                                onChange={(e) => void changeRoleInline(p, e.target.value as SimpleRole)}
                                className="w-32"
                              >
                                <option value="user">User</option>
                                <option value="admin">Admin</option>
                              </Select>
                            ) : (
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                            )}
                            {p.role_source === "deploy" && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Default deploy admin</p>}
                          </td>
                          <td className={TD}>
                            {p.on_roster
                              ? (p.on_call ? <span className="inline-flex items-center gap-1.5"><Dot tone="emerald" pulse />On call now</span> : "On shift roster")
                              : <span className="text-zinc-400">—</span>}
                          </td>
                          <td className={TD}>{p.gmail_connected === null ? <span className="text-zinc-400">—</span> : p.gmail_connected ? "Connected" : <span className="text-zinc-400">Not connected</span>}</td>
                          <td className={TD}>{p.last_active ? <>{fmtRelative(p.last_active)}<span className="ml-1.5 text-xs text-zinc-500">{p.actions} this week</span></> : <span className="text-zinc-400">Not this week</span>}</td>
                          {me?.is_admin && (
                            <td className={cx(TD, "text-right")}>
                              {confirmRemove === p.email ? (
                                <div className="inline-flex items-center gap-1.5">
                                  <Button size="sm" onClick={() => setConfirmRemove(null)} disabled={busy}>Cancel</Button>
                                  <Button size="sm" variant="danger" loading={busy} onClick={() => void removeInline(p)}>Confirm remove</Button>
                                </div>
                              ) : (
                                <div className="inline-flex items-center gap-1.5">
                                  <Button size="sm" onClick={() => setEditing(p)} disabled={busy}>Edit</Button>
                                  <Button size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmRemove(p.email)} disabled={busy} title="Remove person">
                                    Remove
                                  </Button>
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!o.people.length && <p className="p-5 text-sm text-zinc-500 dark:text-zinc-400">Nobody has been added yet. Use Add someone above to grant access.</p>}
              </Card>

              <Card>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {openDomain ? `Unlisted @${openDomain} colleagues can view in read-only mode` : "Invite-only: only people listed above can open the app"}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {openDomain
                        ? `Anyone you add above gets User or Admin permissions; other signed-in @${openDomain} teammates can browse read-only. Turn this off if you want removed or unlisted people blocked completely.`
                        : "Only the people listed in the table above can open this link. Removing someone immediately revokes their access."}
                    </p>
                  </div>
                  {me?.is_admin && workspaceDomain && (
                    <Switch
                      label={`Allow read-only viewing for @${workspaceDomain}`}
                      checked={Boolean(openDomain)}
                      disabled={accessBusy}
                      onChange={(checked) => void toggleOpenViewers(checked)}
                    />
                  )}
                </div>
              </Card>
            </div>
          )}

          {current === "system" && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <StatusCard title="Integrations" ok={tools.data ? tools.data.summary.ready === tools.data.summary.required && !tools.data.summary.failing : null} to="/connections" link="Open Integrations">
                {tools.data ? <><p>{tools.data.summary.ready} of {tools.data.summary.required} needed tools are set.</p><p>{tools.data.summary.connected} checked and connected{tools.data.summary.failing ? `, ${tools.data.summary.failing} failing` : ""}.</p></> : <p>Loading</p>}
              </StatusCard>
              <StatusCard title="Scheduled work" ok={s.tick.ok} to="/help/deploy" link="How it is scheduled">
                <p>{s.tick.minutes_ago === null ? "Has not run yet." : `Last ran ${s.tick.minutes_ago} min ago.`} It runs every minute.</p>
                {s.tick.failed.length > 0 && <p>Failed parts: {s.tick.failed.join(", ")}.</p>}
                {!s.tick.ok && s.tick.minutes_ago === null && <p>The deploy creates its schedule (infra/09_worker.sh).</p>}
              </StatusCard>
              <StatusCard title="The agent" ok={s.agent.runtime ? true : false} to="/connections/runtime" link="Open Agent Runtime">
                <p>{s.agent.runtime ? `Runtime ${short(s.agent.runtime)}` : "No Agent Runtime is connected."}</p>
                <p>Model {s.agent.model} · {s.agent.env} · settings {s.agent.config_version.slice(0, 12)}</p>
              </StatusCard>
              <StatusCard title="Delivery" ok={s.delivery.dead_letters === 0} to="/settings/pubsub" link="Open Delivery">
                <p>{s.delivery.pubsub ? "Posts that fail are tried again." : s.delivery.doorbell === "none" ? "Posts wait for the Chat flow to pick them up." : `Chat is told by ${s.delivery.doorbell} when a post is waiting.`}</p>
                <p>{s.delivery.waiting} waiting to post{s.delivery.waiting ? `, the oldest for ${Math.round(s.delivery.oldest_waiting_min)} min` : ""} · {s.delivery.dead_letters} could not be delivered.</p>
              </StatusCard>
              <StatusCard title="Safety" ok={s.safety.passed} to="/settings/safety" link="Open Safety">
                <p>{s.safety.checks - s.safety.failed.length} of {s.safety.checks} checks pass. Testing is {s.safety.testing ? "ON: emails go to the testing recipients only" : "OFF: emails go to real recipients"}.</p>
                {s.safety.failed.map((f) => <p key={f.id}>{f.title}: {f.fix}</p>)}
              </StatusCard>
              <StatusCard title="BigQuery" ok={s.bigquery.dataset ? s.bigquery.connected : null} to="/connections/bigquery" link="Open BigQuery">
                <p>{s.bigquery.dataset ? `Dataset ${s.bigquery.dataset}.` : "No dataset is connected: events stay in the fast store."}</p>
              </StatusCard>
              <StatusCard title="Switches" ok={null} to="/settings/flags" link="Open Switches">
                <p>{s.switches_on.length} of {s.switches} on.</p>
                <p>{s.switches_on.length ? s.switches_on.map((f) => f.replace(/_/g, " ")).join(", ") : "Every switch starts OFF."}</p>
              </StatusCard>
              <StatusCard title="Alerts" ok={null} to="/activity" link="Open the event log">
                <p>{o.events_seen} alerts received in the last 24 hours.</p>
              </StatusCard>
            </div>
          )}

          {current === "changes" && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
              <Card title="Changes to settings, integrations and people" subtitle="The last 7 days" padded={false}>
                {!o.changes.length ? <p className="p-5 text-sm text-zinc-500 dark:text-zinc-400">No change in the last 7 days.</p> : (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {o.changes.map((c) => (
                      <li key={c.audit_id} className="px-5 py-3">
                        <p className="text-sm text-zinc-900 dark:text-zinc-100">{c.summary || c.action}</p>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{c.actor} · {fmtDateTime(c.ts)}{c.status !== "ok" ? ` · ${c.status}` : ""}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="border-t border-zinc-100 px-5 py-3 text-sm dark:border-zinc-800"><Link to="/settings/audit" className="text-blue-700 hover:underline dark:text-blue-300">Open the full audit log</Link></p>
              </Card>
              <Card title="Active this week" padded={false}>
                {!o.active.length ? <p className="p-5 text-sm text-zinc-500 dark:text-zinc-400">Nobody has acted in the Console this week.</p> : (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {o.active.map((a) => (
                      <li key={a.actor} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                        <span className="min-w-0 truncate text-zinc-900 dark:text-zinc-100">{a.actor}</span>
                        <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{a.actions} actions · {fmtRelative(a.last_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </div>
      )}
      {editing && <PersonForm person={editing} onClose={() => setEditing(null)} onDone={(message) => { setEditing(null); toast(message, "success"); data.reload(); }} />}
    </div>
  );
}
