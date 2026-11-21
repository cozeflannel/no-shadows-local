import { RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NavLink, useParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import type { SettingsResponse } from "../api/types";
import { SchemaForm, type Schema } from "../components/SchemaForm";
import { Alert, Badge, Button, Card, cx, ErrorState, Input, PageHeader, Spinner } from "../components/ui";
import { useApp } from "../context";
import { ConfigSection, HistoryList } from "./settings/ConfigSection";
import { AuditPanel, BigQueryPanel, CostsPanel, DeliveryPanel, PromptsPanel, RuntimePanel, SafetyPanel, SecretsPanel } from "./settings/Panels";

interface PartList { parts: { key: string; label: string; description: string; overridden: boolean }[]; config_version: string; can_edit: boolean }
interface PartDetail { part: string; label: string; description: string; value: Record<string, unknown>; default: Record<string, unknown>; schema: Schema; config_version: string; can_edit: boolean }

const TOOLS = [
  { key: "secrets", label: "Secrets & credentials", admin: true },
  { key: "prompts", label: "AI instructions", admin: false },
  { key: "audit", label: "Audit log", admin: false },
  { key: "history", label: "Change history", admin: false },
];
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

export default function SettingsPage() {
  const { me } = useApp();
  const { key = "flags" } = useParams();
  const parts = useApi<PartList>("/platform");
  const config = useApi<SettingsResponse>("/settings");
  const partKeys = new Set(parts.data?.parts.map((p) => p.key));
  const taken = new Set([...partKeys, ...TOOLS.map((t) => t.key)]);
  const sections = (config.data?.sections ?? []).filter((s) => s.key !== "platform");
  const sectionPath = (k: string) => `/settings/${taken.has(k) ? `config.${k}` : k}`;
  const sectionKey = key.startsWith("config.") ? key.slice(7) : !taken.has(key) ? key : null;

  let body: React.ReactNode;
  if (key === "secrets") body = <SecretsPanel />;
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
        <nav aria-label="Settings" className="scroll-thin h-fit space-y-4 lg:sticky lg:top-16 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="space-y-0.5">
            <p className="px-3 pb-1 text-xs text-zinc-500">Platform</p>
            {(parts.data?.parts ?? []).map((p) => <NavItem key={p.key} to={`/settings/${p.key}`} label={p.label} marked={p.overridden} />)}
          </div>
          <div className="space-y-0.5">
            <p className="px-3 pb-1 text-xs text-zinc-500">Agent</p>
            {sections.map((s) => <NavItem key={s.key} to={sectionPath(s.key)} label={s.label} marked={s.overridden} />)}
            <NavItem to="/rosters" label="Rosters" />
          </div>
          <div className="space-y-0.5">
            <p className="px-3 pb-1 text-xs text-zinc-500">Tools</p>
            {TOOLS.filter((t) => !t.admin || me?.is_admin).map((t) => <NavItem key={t.key} to={`/settings/${t.key}`} label={t.label} />)}
          </div>
        </nav>
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  );
}
