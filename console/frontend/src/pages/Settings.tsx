import { History, RotateCcw, Save, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { apiSend, type ApiError, type FieldError } from "../api/client";
import { useApi } from "../api/hooks";
import type { Json, SaveSectionResponse, SettingsHistoryEntry, SettingsResponse } from "../api/types";
import { ActionsEditor, type ActionRow } from "../components/settings/ActionsEditor";
import { DistributionEditor, type Distribution } from "../components/settings/DistributionEditor";
import { JsonEditor } from "../components/settings/JsonEditor";
import { StructuredEditor } from "../components/settings/StructuredEditor";
import { Alert, Badge, Button, Card, CodeBlock, cx, EmptyState, ErrorState, Input, PageHeader, Spinner, Tabs } from "../components/ui";
import { useApp } from "../context";
import { fmtDateTime } from "../lib/format";

type View = "edit" | "history";

function HistoryList() {
  const { data, error, loading, reload } = useApi<{ history: SettingsHistoryEntry[] }>("/settings/history", { limit: 50 });
  const [open, setOpen] = useState<number | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data?.history.length) return <EmptyState icon={<History className="size-8" />} title="No Console edits yet">The YAML defaults are in effect.</EmptyState>;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {data.history.map((h, i) => (
        <li key={`${h.updated_at}-${i}`} className="py-3">
          <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{h.note || "Config updated"}</span>
            {h.sections_changed.map((s) => <Badge key={s} tone="violet">{s}</Badge>)}
            <span className="ml-auto text-xs text-zinc-500">{h.updated_by} · {fmtDateTime(h.updated_at)}</span>
          </button>
          {open === i && (
            <div className="mt-3 space-y-3">
              {Object.entries(h.changes).map(([section, change]) => (
                <div key={section}>
                  <p className="mb-1 text-xs font-medium text-zinc-500">{section} (override before → after)</p>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <CodeBlock value={change.before ?? "(defaults)"} />
                    <CodeBlock value={change.after ?? "(reset to defaults)"} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function errorsBySection(errors: FieldError[]): Record<string, string> {
  return Object.fromEntries(errors.filter((e) => e.loc.length).map((e) => [String(e.loc[0]), e.msg]));
}

export default function SettingsPage() {
  const { me, toast } = useApp();
  const [search, setSearch] = useSearchParams();
  const { data, error, loading, reload, setData } = useApi<SettingsResponse>("/settings");
  const [view, setView] = useState<View>("edit");
  const section = search.get("section") || "distribution";
  const [draft, setDraft] = useState<Json>(null);
  const [dirty, setDirty] = useState(false);
  const [valid, setValid] = useState(true);
  const [note, setNote] = useState("");
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const meta = data?.sections.find((s) => s.key === section);
  const canEdit = !!data?.can_edit;
  useEffect(() => {
    if (!data) return;
    setDraft(structuredClone(data.config[section] ?? null));
    setDirty(false);
    setValid(true);
    setSaveError(null);
    setNote("");
    setResetKey((k) => k + 1);
    // re-initialize when the section changes or after a save/reload replaced the config
  }, [section, data?.config_version, data === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (key: string) => {
    if (dirty && !window.confirm("Discard unsaved changes to this section?")) return;
    setSearch({ section: key }, { replace: true });
  };
  const change = (v: Json) => { setDraft(v); setDirty(true); };
  const fieldErrors = useMemo(() => errorsBySection(saveError?.errors ?? []), [saveError]);

  const apply = (res: SaveSectionResponse, message: string) => {
    toast(message);
    setData(data && { ...data, config: { ...data.config, [section]: res.value }, config_version: res.config_version,
      sections: data.sections.map((s) => (s.key === section ? { ...s, overridden: res.overridden } : s)) });
  };
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiSend<SaveSectionResponse>("put", `/settings/${section}`, { value: draft, note: note || undefined, base_version: data?.config_version });
      apply(res, `${meta?.label ?? section} saved · config ${res.config_version}`);
    } catch (err) {
      const e = err as ApiError;
      setSaveError(e);
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    if (!window.confirm(`Reset ${meta?.label ?? section} to the YAML defaults?`)) return;
    setSaving(true);
    try {
      apply(await apiSend<SaveSectionResponse>("delete", `/settings/${section}`), `${meta?.label ?? section} reset to defaults`);
    } catch (err) {
      toast((err as ApiError).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const editor = () => {
    if (!meta || draft === null) return <EmptyState title="Unknown section" />;
    const disabled = !canEdit;
    if (meta.kind === "structured") return <StructuredEditor section={section} value={draft as Record<string, Json>} onChange={change} fieldErrors={fieldErrors} disabled={disabled} />;
    if (section === "distribution") return <DistributionEditor value={draft as unknown as Distribution} onChange={change} disabled={disabled} />;
    if (section === "actions") {
      const groups = ((data?.config.distribution as unknown as Distribution | undefined)?.groups ?? []).map((g) => ({ name: g.name, action_code: g.action_code }));
      return <ActionsEditor value={draft as unknown as ActionRow[]} onChange={change} groups={groups} disabled={disabled} />;
    }
    return <JsonEditor key={`${section}-${resetKey}`} value={draft} onChange={change} onValidity={setValid} resetKey={`${section}-${resetKey}`} disabled={disabled} />;
  };

  return (
    <div>
      <PageHeader title="Settings" description="The agent's live configuration: YAML defaults plus Console overrides. Every save is validated against the AgentConfig schema and logged (config.updated)."
        actions={data && <span className="text-xs text-zinc-500">config <span className="font-mono">{data.config_version}</span>{data.last_update ? ` · last edit by ${data.last_update.updated_by} ${fmtDateTime(data.last_update.updated_at)}` : ""}</span>} />
      <Tabs<View> value={view} onChange={setView} tabs={[{ key: "edit", label: "Sections" }, { key: "history", label: "History" }]} />
      <ErrorState error={error} onRetry={reload} />
      {view === "history" ? <Card><HistoryList /></Card> : loading && !data ? <Spinner /> : data && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
          <Card padded={false} className="h-fit lg:sticky lg:top-20">
            <nav className="scroll-thin max-h-[70vh] overflow-y-auto p-2" aria-label="Config sections">
              {data.sections.map((s) => (
                <button key={s.key} type="button" onClick={() => pick(s.key)} aria-current={s.key === section}
                  className={cx("flex w-full items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors",
                    s.key === section ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/70")}>
                  <span className="truncate">{s.label}</span>
                  {s.overridden && <span className="size-1.5 shrink-0 rounded-full bg-violet-500" title="Overridden in the Console" />}
                </button>
              ))}
            </nav>
          </Card>
          <Card
            title={<span className="flex items-center gap-2"><Settings2 className="size-4 text-zinc-400" />{meta?.label ?? section}
              <span className="font-mono text-xs font-normal text-zinc-400">{section}</span>
              {meta?.overridden ? <Badge tone="violet">overridden</Badge> : <Badge tone="zinc">defaults</Badge>}
              <Badge tone="slate">{meta?.kind === "json" ? "JSON" : meta?.kind === "table" ? "table" : "form"}</Badge></span>}
            subtitle={meta?.description}
            actions={<>
              {meta?.overridden && <Button size="sm" icon={<RotateCcw className="size-3.5" />} disabled={!canEdit || saving} onClick={reset}>Reset to defaults</Button>}
              <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={saving} disabled={!canEdit || !dirty || !valid} onClick={save}>Save</Button>
            </>}
          >
            {!canEdit && <Alert tone="blue" className="mb-4" title="Read-only">Only admins can change settings{me ? ` (you are ${me.role})` : ""}.</Alert>}
            {saveError && <ErrorState error={saveError} />}
            {section === "seed_rosters" && <Alert tone="amber" className="mb-4" title="Seed only">These rosters only seed an empty store. Edit live rosters on the Rosters page.</Alert>}
            <div className={cx(saveError && "mt-4")}>{editor()}</div>
            {canEdit && (
              <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Change note (optional, shown in History)" className="max-w-md" aria-label="Change note" />
                <span className="text-xs text-zinc-500">{dirty ? (valid ? "Unsaved changes" : "Fix the JSON to save") : "No changes"}</span>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
