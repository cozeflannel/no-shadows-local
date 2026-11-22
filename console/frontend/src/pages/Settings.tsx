import { RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import type { SettingsResponse } from "../api/types";
import { SchemaForm, type Schema } from "../components/SchemaForm";
import { Alert, Badge, Button, Card, cx, ErrorState, Input, PageHeader, Select, Spinner } from "../components/ui";
import { useApp } from "../context";
import { ConfigSection, HistoryList } from "./settings/ConfigSection";
import { AuditPanel, BigQueryPanel, CostsPanel, DeliveryPanel, PromptsPanel, RuntimePanel, SafetyPanel, SecretsPanel } from "./settings/Panels";

interface PartList { parts: { key: string; label: string; description: string; group: string; overridden: boolean }[]; config_version: string; can_edit: boolean }
interface PartDetail { part: string; label: string; description: string; value: Record<string, unknown>; default: Record<string, unknown>; schema: Schema; config_version: string; can_edit: boolean }

const TOOLS = [
  { key: "secrets", label: "Secrets (API tokens)", admin: true },
  { key: "prompts", label: "What Gemini is told", admin: false },
  { key: "audit", label: "Who did what", admin: false },
  { key: "history", label: "Changes to settings", admin: false },
];
/** The parts whose main values connect a tool: those are set under Integrations. */
const PART_TOOL: Record<string, string> = { gcp: "gcp", bigquery: "bigquery", pubsub: "delivery", temp_check: "brandwatch", campaigns: "campaigns" };
const PART_PANEL: Record<string, () => React.ReactNode> = {
  bigquery: () => <BigQueryPanel />, pubsub: () => <DeliveryPanel />, safety: () => <SafetyPanel />, costs: () => <CostsPanel />, gcp: () => <RuntimePanel />,
};

function PartEditor({ part, onSaved }: { part: string; onSaved: () => void }) {
  const { toast, me } = useApp();
  const { data, error, loading, setData, reload } = useApi<PartDetail>(`/platform/${part}`);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  useEffect(() => { if (data) { setDraft(structuredClone(data.value)); setDirty(false); setSaveError(null); setNote(""); } }, [data]);
  const errors = useMemo(() => Object.fromEntries((saveError?.errors ?? []).map((e) => [e.loc.join("."), e.msg])), [saveError]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const save = async (value: Record<string, unknown>, message: string) => {
    setSaving(true); setSaveError(null);
    try {
      const res = await apiSend<{ value: Record<string, unknown>; config_version: string; changed: string[] }>("put", `/platform/${part}`, { value, note: note || undefined, base_version: data.config_version });
      toast(res.changed.length ? `${message}: ${res.changed.join(", ")}` : "Nothing changed");
      setData({ ...data, value: res.value, config_version: res.config_version });
      onSaved();
    } catch (err) {
      const e = err as ApiError;
      setSaveError(e);
      toast(e.status === 409 ? "Someone else changed the settings. They were reloaded: make your change again." : e.message, "error");
      if (e.status === 409) reload();
    } finally { setSaving(false); }
  };
  const changed = JSON.stringify(data.value) !== JSON.stringify(data.default);
  return (
    <Card title={<span className="flex items-center gap-2">{data.label}{changed ? <Badge tone="violet">changed</Badge> : <Badge tone="zinc">default</Badge>}</span>} subtitle={data.description}
      actions={<>
        {changed && <Button size="sm" icon={<RotateCcw className="size-3.5" />} disabled={!data.can_edit || saving} onClick={() => { if (window.confirm(`Reset ${data.label} to the defaults?`)) void save(data.default, "Reset"); }}>Reset</Button>}
        <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={saving} disabled={!data.can_edit || !dirty} onClick={() => save(draft, "Saved")}>Save</Button>
      </>}>
      {PART_TOOL[part] && <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">The values that connect this tool are set under <Link to={`/connections/${PART_TOOL[part]}`} className="text-blue-700 hover:underline dark:text-blue-300">Integrations</Link>. The rest here is tuning.</p>}
      {!data.can_edit && <Alert tone="blue" className="mb-3" title="Read-only">Only admins can change settings{me ? ` (you are ${me.role})` : ""}.</Alert>}
      {saveError && saveError.status !== 409 && <ErrorState error={saveError} />}
      <SchemaForm schema={data.schema} value={draft} errors={errors} disabled={!data.can_edit} onChange={(v) => { setDraft(v); setDirty(true); }} />
      {data.can_edit && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the history (optional)" className="max-w-md" aria-label="Change note" />
          <span className="text-xs text-zinc-500">{dirty ? "Unsaved changes. They apply as soon as you save." : "No changes"}</span>
        </div>
      )}
    </Card>
  );
}

function NavItem({ to, label, marked }: { to: string; label: string; marked?: boolean }) {
  return (
    <NavLink to={to} className={({ isActive }) => cx("flex items-center justify-between gap-2 rounded-full px-3 py-1.5 text-sm",
      isActive ? "bg-blue-100 font-medium text-blue-800 dark:bg-blue-200/15 dark:text-blue-200" : "text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800")}>
      <span className="truncate">{label}</span>{marked && <span className="size-1.5 shrink-0 rounded-full bg-violet-400" title="Changed from the default" />}
    </NavLink>
  );
}

interface Glance {
  tools: { summary: { required: number; ready: number; connected: number; failing: number } } | null;
  admin: { people: unknown[]; status: { switches_on: string[]; switches: number; safety: { passed: boolean; testing: boolean } } } | null;
}

function StartCard({ n, title, state, to, action, done }: { n: number; title: string; state: string; to: string; action: string; done: boolean }) {
  return (
    <Link to={to} className="flex items-start gap-4 rounded-2xl border border-zinc-200 bg-white p-5 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/60">
      <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-full text-sm tabular-nums", done ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100")}>{n}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium text-zinc-950 dark:text-zinc-50">{title}</span>
        <span className="mt-0.5 block text-sm text-zinc-600 dark:text-zinc-400">{state}</span>
        <span className="mt-2 block text-sm font-medium text-blue-700 dark:text-blue-300">{action}</span>
      </span>
    </Link>
  );
}

/** What an admin fills in, in order. Everything else has a working default. */
function SettingsHome({ tools, admin }: Glance) {
  const t = tools?.summary;
  const s = admin?.status;
  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">Four things to fill in. Everything else already has a value that works; change one under More settings only when you need to.</p>
      <div className="flex flex-col gap-3">
        <StartCard n={1} title="Integrations" done={!!t && t.ready === t.required} to="/connections" action="Open Integrations"
          state={t ? `${t.ready} of ${t.required} needed tools are set${t.failing ? `, ${t.failing} failing a check` : ""}. Set up fills what the project already has and checks each tool.` : "The tools the agent is connected to."} />
        <StartCard n={2} title="People" done={!!admin && admin.people.length > 1} to="/admin" action="Open People"
          state={admin ? `${admin.people.length} ${admin.people.length === 1 ? "person has" : "people have"} a role. Add a person once: their role and roster place come from that record.` : "Who can work alerts and who can change settings."} />
        <StartCard n={3} title="Switches" done={!!s && s.switches_on.length > 0} to="/settings/flags" action="Open Switches"
          state={s ? `${s.switches_on.length} of ${s.switches} on. Every feature starts OFF.` : "What the agent may do on its own."} />
        <StartCard n={4} title="Safety and Testing" done={!!s && s.safety.passed} to="/settings/safety" action="Open Safety and Testing"
          state={s ? `Testing is ${s.safety.testing ? "ON: emails go only to the testing recipients" : "OFF: emails go to real recipients"}.` : "Testing recipients, allow-lists and the leak guard."} />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { me } = useApp();
  const { key } = useParams();
  const navigate = useNavigate();
  const parts = useApi<PartList>("/platform");
  const config = useApi<SettingsResponse>("/settings");
  const tools = useApi<Glance["tools"]>(key ? null : "/connections");
  const admin = useApi<Glance["admin"]>(key ? null : "/admin/overview");
  const [find, setFind] = useState("");
  const [open, setOpen] = useState(false);
  const partKeys = new Set(parts.data?.parts.map((p) => p.key));
  const taken = new Set([...partKeys, ...TOOLS.map((t) => t.key)]);
  const sections = (config.data?.sections ?? []).filter((s) => s.key !== "platform");
  const sectionPath = (k: string) => `/settings/${taken.has(k) ? `config.${k}` : k}`;
  const sectionKey = !key ? null : key.startsWith("config.") ? key.slice(7) : !taken.has(key) ? key : null;
  const start = ["flags", "safety"];
  const needle = find.trim().toLowerCase();
  const match = (label: string) => !needle || label.toLowerCase().includes(needle);
  const pages = [
    ...(parts.data?.parts ?? []).filter((p) => !start.includes(p.key)).map((p) => ({ group: p.group, to: `/settings/${p.key}`, label: p.label, marked: p.overridden })),
    ...sections.map((x) => ({ group: x.group, to: sectionPath(x.key), label: x.label, marked: x.overridden })),
    { group: "day", to: "/rosters", label: "Rosters", marked: false },
  ].filter((i) => match(i.label));
  const groups: { title: string; items: { to: string; label: string; marked?: boolean }[] }[] = [
    ...(config.data?.groups ?? []).map((g) => ({ title: g.title, items: pages.filter((i) => i.group === g.key).sort((x, y) => x.label.localeCompare(y.label)) })),
    { title: "Records and tools", items: TOOLS.filter((t) => (!t.admin || me?.is_admin) && match(t.label)).map((t) => ({ to: `/settings/${t.key}`, label: t.label })) },
  ];
  const advanced = open || !!needle || (!!key && !start.includes(key));

  let body: React.ReactNode;
  if (!key) body = <SettingsHome tools={tools.data} admin={admin.data} />;
  else if (key === "secrets") body = <SecretsPanel />;
  else if (key === "prompts") body = <PromptsPanel />;
  else if (key === "audit") body = <AuditPanel />;
  else if (key === "history") body = <Card title="Change history"><HistoryList /></Card>;
  else if (sectionKey) body = config.loading && !config.data ? <Spinner /> : config.data && sections.some((s) => s.key === sectionKey)
    ? <ConfigSection section={sectionKey} data={config.data} setData={config.setData} /> : <Alert tone="amber" title="No such setting">Pick one from the list.</Alert>;
  else body = <div className="space-y-5"><PartEditor key={key} part={key} onSaved={parts.reload} />{PART_PANEL[key]?.()}</div>;

  return (
    <div>
      <PageHeader title="Settings" actions={parts.data && <span className="text-xs text-zinc-500">version {parts.data.config_version}</span>} />
      <ErrorState error={parts.error || config.error} onRetry={() => { parts.reload(); config.reload(); }} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[15rem_1fr]">
        <Select className="lg:hidden" aria-label="Setting" value={key ? `/settings/${key}` : "/settings"} onChange={(e) => navigate(e.target.value)}>
          <optgroup label="Start here">
            <option value="/settings">What to fill in</option><option value="/connections">Integrations</option><option value="/admin">People</option>
            <option value="/settings/flags">Switches</option><option value="/settings/safety">Safety and Testing</option>
          </optgroup>
          {groups.map((g) => g.items.length > 0 && <optgroup key={g.title} label={g.title}>{g.items.map((i) => <option key={i.to} value={i.to}>{i.label}</option>)}</optgroup>)}
        </Select>
        <nav aria-label="Settings" className="scroll-thin hidden h-fit space-y-4 lg:sticky lg:top-16 lg:block lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="space-y-0.5">
            <p className="px-3 pb-1 text-xs text-zinc-500">Start here</p>
            <NavLink to="/settings" end className={({ isActive }) => cx("flex rounded-full px-3 py-1.5 text-sm", isActive ? "bg-blue-100 font-medium text-blue-800 dark:bg-blue-200/15 dark:text-blue-200" : "text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800")}>What to fill in</NavLink>
            <NavItem to="/connections" label="Integrations" />
            <NavItem to="/admin" label="People" />
            <NavItem to="/settings/flags" label="Switches" marked={parts.data?.parts.find((p) => p.key === "flags")?.overridden} />
            <NavItem to="/settings/safety" label="Safety and Testing" marked={parts.data?.parts.find((p) => p.key === "safety")?.overridden} />
          </div>
          <div>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={advanced} className="flex w-full items-center justify-between rounded-full px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800">
              More settings<span className="text-xs text-zinc-500">{advanced ? "Hide" : "Show"}</span>
            </button>
            {advanced && (
              <div className="mt-2 space-y-4">
                <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a setting" aria-label="Find a setting" />
                {groups.map((g) => g.items.length > 0 && (
                  <div key={g.title} className="space-y-0.5">
                    <p className="px-3 pb-1 text-xs text-zinc-500">{g.title}</p>
                    {g.items.map((i) => <NavItem key={i.to} to={i.to} label={i.label} marked={i.marked} />)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </nav>
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  );
}
