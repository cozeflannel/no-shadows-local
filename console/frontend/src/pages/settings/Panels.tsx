import { CircleCheck, CircleX, Download, KeyRound, Play, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { apiGet, apiSend, type ApiError } from "../../api/client";
import { useApi } from "../../api/hooks";
import { Alert, Badge, Button, Card, CodeBlock, cx, EmptyState, ErrorState, Field, Input, Modal, OffNotice, Segmented, Select, Spinner, Stat, TD, TH, TR, Textarea } from "../../components/ui";
import { useApp } from "../../context";
import { fmtDateTime, fmtNum, fmtRelative } from "../../lib/format";

function useDo(reload: () => void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState("");
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast(done); reload(); return true; } catch (err) { toast((err as ApiError).message, "error"); return false; } finally { setBusy(""); }
  };
  return { busy, run };
}

// -- the deployed agent -----------------------------------------------------------------------------------------------------
interface Runtime { resource: string; reachable: boolean; error: string; console_config_version: string; agent_config_version?: string; same_settings?: boolean; env?: string }

export function RuntimePanel() {
  const r = useApi<Runtime>("/agent-runtime");
  if (r.loading && !r.data) return <Spinner label="Asking the deployed agent" />;
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return null;
  const d = r.data;
  return (
    <Card title="The deployed agent" subtitle="The agent that Chat calls. It uses these settings as soon as they are saved." actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={r.reload}>Ask again</Button>}>
      {!d.resource ? <Alert tone="amber" title="No Agent Runtime is named">Run infra/deploy.sh, or paste the resource name above and save.</Alert>
        : !d.reachable ? <Alert tone="rose" title="The agent did not answer">{d.error}</Alert>
          : d.same_settings ? <Alert tone="emerald" title="Answering, on the same settings as the Console">Environment {d.env}, settings version {d.agent_config_version}.</Alert>
            : <Alert tone="amber" title="Answering, on older settings">The agent is on {d.agent_config_version}; the Console is on {d.console_config_version}. It picks up a change within a few seconds: ask again.</Alert>}
    </Card>
  );
}

// -- secrets ----------------------------------------------------------------------------------------------------------------
interface SecretList { secrets: { name: string; created: string | null }[]; prefix: string; missing: { name: string; used_for: string }[]; can_write: boolean; backend: string }

export function SecretsPanel() {
  const s = useApi<SecretList>("/secrets");
  const { busy, run } = useDo(s.reload);
  const [form, setForm] = useState<{ name: string; value: string; existing: boolean } | null>(null);
  const [open, setOpen] = useState("");
  const versions = useApi<{ versions: { version: string; state: string; created: string | null }[] }>(open ? `/secrets/${open}/versions` : null);
  if (s.loading && !s.data) return <Spinner />;
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  if (!s.data) return null;
  const save = async () => {
    if (!form) return;
    const ok = await run("save", () => (form.existing ? apiSend("post", `/secrets/${form.name}/versions`, { value: form.value }) : apiSend("post", "/secrets", { name: form.name, value: form.value })), "Saved");
    if (ok) { setForm(null); versions.reload(); }
  };
  return (
    <div className="space-y-5">
      {!s.data.can_write && <OffNotice what="Changing secrets from the Console" flag="secret_admin">Secrets are listed; values can never be read back here.</OffNotice>}
      {s.data.missing.map((m) => (
        <Alert key={m.name} tone="amber" title={`A setting names the secret "${m.name}" but it does not exist`}>
          Used for {m.used_for}. <button type="button" className="font-medium underline" disabled={!s.data!.can_write} onClick={() => setForm({ name: m.name, value: "", existing: false })}>Add it</button>
        </Alert>
      ))}
      <Card padded={false} title="Secrets" subtitle={`Kept in ${s.data.backend}${s.data.prefix ? `, names starting with ${s.data.prefix}` : ""}. A value is written, never shown.`}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} disabled={!s.data.can_write} onClick={() => setForm({ name: s.data!.prefix, value: "", existing: false })}>New secret</Button>}>
        {s.data.secrets.length === 0 ? <EmptyState icon={<KeyRound className="size-8" />} title="No secrets yet">API tokens and credentials go here, not in settings.</EmptyState> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {s.data.secrets.map((x) => (
              <li key={x.name}>
                <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === x.name ? "" : x.name)} aria-expanded={open === x.name}>
                    <span className="font-mono text-sm text-zinc-900 dark:text-zinc-100">{x.name}</span><span className="ml-3 text-xs text-zinc-500">{x.created ? `created ${fmtRelative(x.created)}` : ""}</span>
                  </button>
                  <Button size="sm" disabled={!s.data!.can_write} onClick={() => setForm({ name: x.name, value: "", existing: true })}>New value</Button>
                </div>
                {open === x.name && (
                  <div className="border-t border-zinc-100 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                    {versions.loading && !versions.data ? <Spinner /> : (
                      <ul className="space-y-2 text-sm">{(versions.data?.versions ?? []).map((v) => (
                        <li key={v.version} className="flex flex-wrap items-center gap-3">
                          <span className="tabular-nums">Version {v.version}</span><Badge tone={v.state === "ENABLED" ? "emerald" : v.state === "DISABLED" ? "amber" : "zinc"}>{v.state.toLowerCase()}</Badge>
                          <span className="text-xs text-zinc-500">{v.created ? fmtDateTime(v.created) : ""}</span>
                          <span className="ml-auto flex gap-2">
                            {v.state === "ENABLED" && <Button size="sm" disabled={!s.data!.can_write} loading={busy === `${v.version}DISABLED`} onClick={() => run(`${v.version}DISABLED`, () => apiSend("post", `/secrets/${x.name}/versions/${v.version}`, { state: "DISABLED" }), "Disabled").then(() => versions.reload())}>Disable</Button>}
                            {v.state === "DISABLED" && <Button size="sm" disabled={!s.data!.can_write} loading={busy === `${v.version}ENABLED`} onClick={() => run(`${v.version}ENABLED`, () => apiSend("post", `/secrets/${x.name}/versions/${v.version}`, { state: "ENABLED" }), "Enabled").then(() => versions.reload())}>Enable</Button>}
                            {v.state !== "DESTROYED" && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={!s.data!.can_write}
                              onClick={() => { if (window.confirm(`Destroy version ${v.version} of ${x.name}? This cannot be undone.`)) void run(`${v.version}DESTROYED`, () => apiSend("post", `/secrets/${x.name}/versions/${v.version}`, { state: "DESTROYED" }), "Destroyed").then(() => versions.reload()); }}>Destroy</Button>}
                          </span>
                        </li>))}</ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal open={!!form} title={form?.existing ? `New value for ${form.name}` : "New secret"} onClose={() => setForm(null)}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={busy === "save"} disabled={!form?.name.trim() || !form.value} onClick={save}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            {!form.existing && <Field label="Name" hint="Letters, digits, dashes and underscores. Put this name in the setting that uses it."><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>}
            <Field label="Value" hint="Stored as a new version. The agent reads the newest enabled version."><Textarea rows={4} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} autoComplete="off" spellCheck={false} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

// -- BigQuery ---------------------------------------------------------------------------------------------------------------
interface BqStatus { settings: { project: string; dataset: string; location: string; tables: Record<string, string> }; connected: boolean; error: string; can_admin: boolean; logical_tables: { key: string; description: string }[]; project?: string; identity?: string }
interface BqField { name: string; type: string; mode?: string; description?: string }
interface BqTable { full_id: string; type: string; description: string; rows: number | null; bytes: number | null; modified: string | null; schema: BqField[]; partition_field: string | null; clustering: string[]; view_query: string }

export function BigQueryPanel() {
  const { toast } = useApp();
  const st = useApi<BqStatus>("/bigquery/status");
  const datasets = useApi<{ datasets: { dataset: string; full_id: string }[] }>(st.data?.connected ? "/bigquery/datasets" : null);
  const [dataset, setDataset] = useState("");
  const tables = useApi<{ dataset: { location: string; description: string }; tables: { table: string; type: string; full_id: string }[] }>(dataset ? `/bigquery/datasets/${dataset}/tables` : null);
  const [tableId, setTableId] = useState("");
  const [table, setTable] = useState<{ table: BqTable; field_types: string[]; rows?: Record<string, unknown>[] } | null>(null);
  const [fields, setFields] = useState<BqField[]>([]);
  const [desc, setDesc] = useState("");
  const [sql, setSql] = useState("");
  const [create, setCreate] = useState<null | "dataset" | "table" | "view">(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const { busy, run } = useDo(() => { st.reload(); datasets.reload(); tables.reload(); });
  useEffect(() => { if (!dataset && st.data?.settings.dataset) setDataset(st.data.settings.dataset.split(".").pop() ?? ""); }, [st.data, dataset]);
  const load = async (id: string, preview = 0) => {
    setTableId(id); setError(null);
    try {
      const t = await apiGet<{ table: BqTable; field_types: string[]; rows?: Record<string, unknown>[] }>(`/bigquery/tables/${id}`, { preview });
      setTable(t); setFields(t.table.schema.map((f) => ({ ...f }))); setDesc(t.table.description); setSql(t.table.view_query);
    } catch (err) { setError(err as ApiError); setTable(null); }
  };
  if (st.loading && !st.data) return <Spinner />;
  if (st.error) return <ErrorState error={st.error} onRetry={st.reload} />;
  if (!st.data) return null;
  const can = st.data.can_admin;
  const types = table?.field_types ?? ["STRING", "INT64", "FLOAT64", "BOOL", "TIMESTAMP", "DATE", "JSON"];
  const isView = table?.table.type === "VIEW";
  const submitCreate = async () => {
    const project = st.data!.project || st.data!.settings.project;
    const ok = create === "dataset" ? await run("create", () => apiSend("post", "/bigquery/datasets", { dataset: newName }), "Dataset created")
      : create === "table" ? await run("create", () => apiSend("post", "/bigquery/tables", { table_id: `${project}.${dataset}.${newName}`, fields: fields.filter((f) => f.name.trim()), description: desc }), "Table created")
        : await run("create", () => apiSend("put", `/bigquery/views/${project}.${dataset}.${newName}`, { sql, description: desc }), "View saved");
    if (ok) { if (create === "dataset") setDataset(newName); setCreate(null); setNewName(""); }
  };
  const schemaEditor = (
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={i} className="grid grid-cols-[1fr_9rem_8rem_1.5fr_auto] items-center gap-2">
          <Input value={f.name} placeholder="column" aria-label="Column name" disabled={!can} onChange={(e) => setFields(fields.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} />
          <Select value={f.type} aria-label="Type" disabled={!can} onChange={(e) => setFields(fields.map((x, n) => (n === i ? { ...x, type: e.target.value } : x)))}>{types.map((t) => <option key={t}>{t}</option>)}{!types.includes(f.type) && <option>{f.type}</option>}</Select>
          <Select value={f.mode ?? "NULLABLE"} aria-label="Mode" disabled={!can} onChange={(e) => setFields(fields.map((x, n) => (n === i ? { ...x, mode: e.target.value } : x)))}><option>NULLABLE</option><option>REQUIRED</option><option>REPEATED</option></Select>
          <Input value={f.description ?? ""} placeholder="description" aria-label="Description" disabled={!can} onChange={(e) => setFields(fields.map((x, n) => (n === i ? { ...x, description: e.target.value } : x)))} />
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label={`Remove ${f.name}`} disabled={!can} onClick={() => setFields(fields.filter((_, n) => n !== i))} />
        </div>
      ))}
      <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!can} onClick={() => setFields([...fields, { name: "", type: "STRING", mode: "NULLABLE", description: "" }])}>Add column</Button>
    </div>
  );
  return (
    <div className="space-y-5">
      {st.data.connected ? <Alert tone="emerald" title={`Connected to ${st.data.project}`}>Running as {st.data.identity}.</Alert>
        : <Alert tone="amber" title="BigQuery is not connected">{st.data.error || "Set the project above and save."}</Alert>}
      {!can && <OffNotice what="Changing BigQuery from the Console" flag="bigquery_admin">Datasets and tables can be listed and previewed.</OffNotice>}
      <Card title="The agent's tables" subtitle="Where each kind of row is written. Create the missing ones in the dataset set above, and map them, in one step."
        actions={<Button variant="primary" icon={<Play className="size-4" />} disabled={!can || !st.data.connected || !st.data.settings.dataset} loading={busy === "provision"} onClick={() => run("provision", () => apiSend("post", "/bigquery/provision"), "Tables created and mapped")}>Create and map</Button>}>
        <ul className="space-y-2 text-sm">{st.data.logical_tables.map((t) => (
          <li key={t.key} className="flex flex-wrap items-baseline gap-x-3"><span className="w-24 font-medium">{t.key}</span><span className="font-mono text-xs text-zinc-600 dark:text-zinc-300">{st.data!.settings.tables[t.key] || "not mapped"}</span><span className="text-xs text-zinc-500">{t.description}</span></li>))}</ul>
      </Card>
      {st.data.connected && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[18rem_1fr]">
          <Card padded={false} title="Browse" actions={<Button size="sm" icon={<Plus className="size-3.5" />} disabled={!can} onClick={() => { setCreate("dataset"); setNewName(""); }}>Dataset</Button>}>
            <div className="p-3"><Select value={dataset} onChange={(e) => { setDataset(e.target.value); setTable(null); setTableId(""); }} aria-label="Dataset"><option value="">Choose a dataset</option>{(datasets.data?.datasets ?? []).map((d) => <option key={d.full_id} value={d.dataset}>{d.dataset}</option>)}</Select></div>
            {dataset && <>
              <ul className="scroll-thin max-h-96 overflow-y-auto border-t border-zinc-100 dark:border-zinc-800">
                {(tables.data?.tables ?? []).map((t) => (
                  <li key={t.full_id}><button type="button" onClick={() => load(t.full_id)} aria-current={tableId === t.full_id}
                    className={cx("flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm", tableId === t.full_id ? "bg-blue-100 text-blue-800 dark:bg-blue-200/15 dark:text-blue-200" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50")}>
                    <span className="truncate font-mono text-xs">{t.table}</span><Badge tone="zinc">{t.type.toLowerCase()}</Badge></button></li>))}
                {tables.data && tables.data.tables.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">Empty dataset.</li>}
              </ul>
              <div className="flex gap-2 border-t border-zinc-100 p-3 dark:border-zinc-800">
                <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!can} onClick={() => { setCreate("table"); setNewName(""); setFields([{ name: "", type: "STRING", mode: "NULLABLE", description: "" }]); setDesc(""); }}>Table</Button>
                <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!can} onClick={() => { setCreate("view"); setNewName(""); setSql(""); setDesc(""); }}>View</Button>
              </div>
            </>}
          </Card>
          <div>
            <ErrorState error={error} />
            {!table ? <Card><EmptyState title="Pick a table or a view">Its schema, description and a preview open here.</EmptyState></Card> : (
              <Card title={<span className="font-mono text-sm">{table.table.full_id}</span>}
                subtitle={`${table.table.type.toLowerCase()}${table.table.rows !== null ? `, ${fmtNum(table.table.rows)} rows` : ""}${table.table.partition_field ? `, partitioned by ${table.table.partition_field}` : ""}${table.table.modified ? `, changed ${fmtRelative(table.table.modified)}` : ""}`}
                actions={<>
                  <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => load(table.table.full_id, 20)}>Preview rows</Button>
                  <Button size="sm" variant="primary" disabled={!can} loading={busy === "save"}
                    onClick={() => run("save", () => (isView ? apiSend("put", `/bigquery/views/${table.table.full_id}`, { sql, description: desc }) : apiSend("put", `/bigquery/tables/${table.table.full_id}`, { fields, description: desc })), "Saved").then(() => load(table.table.full_id))}>Save</Button>
                </>}>
                <Field label="Description" className="mb-4"><Input value={desc} disabled={!can} onChange={(e) => setDesc(e.target.value)} /></Field>
                {isView ? <Field label="Query"><Textarea rows={10} value={sql} disabled={!can} onChange={(e) => setSql(e.target.value)} spellCheck={false} /></Field>
                  : <><p className="mb-2 text-xs text-zinc-500">Columns can be added, described and relaxed to nullable. BigQuery refuses a removed or retyped column.</p>{schemaEditor}</>}
                {table.rows && <div className="mt-4"><CodeBlock value={table.rows} /></div>}
              </Card>
            )}
          </div>
        </div>
      )}
      <Modal open={!!create} wide={create !== "dataset"} title={create === "dataset" ? "New dataset" : create === "table" ? `New table in ${dataset}` : `New view in ${dataset}`} onClose={() => setCreate(null)}
        footer={<><Button onClick={() => setCreate(null)}>Cancel</Button><Button variant="primary" loading={busy === "create"} disabled={!newName.trim() || (create === "view" && !sql.trim())} onClick={() => { void submitCreate().catch((e) => toast(String(e), "error")); }}>Create</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>
          {create !== "dataset" && <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>}
          {create === "table" && <Field label="Columns">{schemaEditor}</Field>}
          {create === "view" && <Field label="Query"><Textarea rows={10} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} /></Field>}
        </div>
      </Modal>
    </div>
  );
}

// -- delivery ---------------------------------------------------------------------------------------------------------------
interface Dead { action: { action_id: string; kind: string; case_id: string | null; created_at: string; payload: Record<string, unknown> }; status: string; attempts: number; last_error: string; updated_at: string | null }
interface Delivery {
  status: { enabled: boolean; transport?: string; project?: string; error?: string; resources: { kind: string; name: string; exists: boolean; error?: string }[] };
  outbox_doorbell: string; dead_letters: Dead[]; recent: Dead[]; counts: Record<string, number>;
  outbox_waiting: { outbox_id: string; target: string; case_id: string | null; waiting_min: number; text: string }[];
}

export function DeliveryPanel() {
  const { me } = useApp();
  const d = useApi<Delivery>("/delivery", undefined, 30_000);
  const { busy, run } = useDo(d.reload);
  const [steps, setSteps] = useState<{ step: string; ok: boolean; detail: string }[] | null>(null);
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  const x = d.data;
  const provision = async () => {
    try { setSteps((await apiSend<{ steps: { step: string; ok: boolean; detail: string }[] }>("post", "/delivery/provision")).steps); d.reload(); } catch (err) { setSteps([{ step: "provision", ok: false, detail: (err as ApiError).message }]); }
  };
  return (
    <div className="space-y-5">
      {!x.status.enabled && <OffNotice what="Trying again when a post fails" flag="pubsub_delivery">Each post waits for the Chat flow to pick it up.</OffNotice>}
      {x.status.error && <Alert tone="rose" title="Pub/Sub could not be read">{x.status.error}</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Gave up" value={x.dead_letters.length} hint="waiting for a decision" tone={x.dead_letters.length ? "rose" : undefined} glow={x.dead_letters.length > 0} />
        <Stat label="Delivered" value={x.counts.delivered ?? 0} hint="of the last 80" />
        <Stat label="Retrying" value={x.counts.failed ?? 0} />
        <Stat label="Queued" value={x.counts.published ?? 0} />
        <Stat label="Waiting to post" value={x.outbox_waiting.length} hint="in the outbox" tone={x.outbox_waiting.length ? "amber" : undefined} />
      </div>
      <Card title="Topics and subscriptions" subtitle={x.status.transport === "local" ? "This is the local backend: delivery runs in-process." : `Project ${x.status.project || "not set"}`}
        actions={<Button variant="primary" icon={<Play className="size-4" />} disabled={!me?.is_admin} onClick={provision}>Create what is missing</Button>}>
        {x.status.resources.length === 0 ? <p className="text-sm text-zinc-500">Name the topics above, save, then create them here.</p> : (
          <ul className="space-y-1.5 text-sm">{x.status.resources.map((r) => (
            <li key={r.kind + r.name} className="flex flex-wrap items-center gap-2">{r.exists ? <CircleCheck className="size-4 text-emerald-500" /> : <CircleX className="size-4 text-rose-500" />}<span className="w-40 text-zinc-500">{r.kind.replace(/_/g, " ")}</span><span className="font-mono text-xs">{r.name}</span>{r.error && <span className="text-xs text-rose-500">{r.error}</span>}</li>))}</ul>
        )}
        {steps && <ul className="mt-4 space-y-1 border-t border-zinc-100 pt-3 text-sm dark:border-zinc-800">{steps.map((s2) => <li key={s2.step} className={s2.ok ? "text-zinc-600 dark:text-zinc-300" : "text-rose-500"}>{s2.step}: {s2.detail}</li>)}</ul>}
      </Card>
      <Card padded={false} title="Posts that could not be delivered" subtitle="Every try failed. Fix the cause and click Replay, or Discard it.">
        {x.dead_letters.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-500">None.</p> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{x.dead_letters.map((dl) => (
            <li key={dl.action.action_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{dl.action.kind}{dl.action.case_id ? `, ${dl.action.case_id}` : ""} <span className="text-xs font-normal text-zinc-500">{dl.attempts} attempts, {fmtRelative(dl.updated_at ?? dl.action.created_at)}</span></p>
                <p className="break-words text-xs text-rose-500">{dl.last_error}</p>
              </div>
              <Button size="sm" variant="primary" icon={<RotateCcw className="size-3.5" />} disabled={!me?.is_lead} loading={busy === `r${dl.action.action_id}`} onClick={() => run(`r${dl.action.action_id}`, () => apiSend("post", `/delivery/dead-letters/${dl.action.action_id}/replay`), "Replayed")}>Replay</Button>
              <Button size="sm" disabled={!me?.is_lead} loading={busy === `d${dl.action.action_id}`}
                onClick={() => { const reason = window.prompt("Why is it discarded?"); if (reason !== null) void run(`d${dl.action.action_id}`, () => apiSend("post", `/delivery/dead-letters/${dl.action.action_id}/discard`, { reason }), "Discarded"); }}>Discard</Button>
            </li>))}</ul>
        )}
      </Card>
      {x.outbox_waiting.length > 0 && (
        <Card padded={false} title="Waiting to post" actions={<Link to="/outbox" className="text-sm font-medium text-blue-600 dark:text-blue-200">Open the outbox</Link>}>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{x.outbox_waiting.slice(0, 20).map((o) => (
            <li key={o.outbox_id} className="px-5 py-2.5 text-sm"><span className="font-medium">{o.target}</span><span className="ml-2 text-xs text-zinc-500">{o.case_id} waiting {Math.round(o.waiting_min)} min</span><p className="line-clamp-1 text-xs text-zinc-500">{o.text}</p></li>))}</ul>
        </Card>
      )}
    </div>
  );
}

// -- AI instructions --------------------------------------------------------------------------------------------------------
interface Purpose { purpose: string; description: string; versions: number; active_version: number | null; active_model: string; last_called_at: string | null }
interface PromptDetail { purpose: string; description: string; default_system: string; versions: { version: number; system: string; model: string; temperature: number | null; note: string; active: boolean; created_by: string; created_at: string }[]; active_version: number | null }

export function PromptsPanel() {
  const list = useApi<{ purposes: Purpose[]; models: Record<string, string | number>; can_edit: boolean }>("/prompts");
  const [purpose, setPurpose] = useState("");
  const detail = useApi<PromptDetail>(purpose ? `/prompts/${purpose}` : null);
  const { busy, run } = useDo(() => { list.reload(); detail.reload(); });
  const [form, setForm] = useState({ system: "", model: "", temperature: "", note: "" });
  useEffect(() => {
    const active = detail.data?.versions.find((v) => v.active);
    setForm({ system: active?.system ?? "", model: active?.model ?? "", temperature: active?.temperature === null || active?.temperature === undefined ? "" : String(active.temperature), note: "" });
  }, [detail.data]);
  if (list.loading && !list.data) return <Spinner />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  const can = list.data.can_edit;
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[20rem_1fr]">
      <Card padded={false} title="What Gemini is asked to do" subtitle={`Default models: triage ${list.data.models.triage}, drafting ${list.data.models.drafting}, answers ${list.data.models.converse}.`}>
        <ul className="scroll-thin max-h-[70vh] overflow-y-auto">
          {list.data.purposes.map((p) => (
            <li key={p.purpose}><button type="button" onClick={() => setPurpose(p.purpose)} aria-current={purpose === p.purpose}
              className={cx("block w-full px-5 py-2.5 text-left", purpose === p.purpose ? "bg-blue-100 dark:bg-blue-200/15" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50")}>
              <span className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.purpose}{p.active_version ? <Badge tone="violet">v{p.active_version}</Badge> : null}</span>
              <span className="line-clamp-2 text-xs text-zinc-500">{p.description}</span></button></li>))}
        </ul>
      </Card>
      {!purpose ? <Card><EmptyState title="Pick a purpose">Its built-in instructions and every published version open here.</EmptyState></Card> : detail.loading && !detail.data ? <Spinner /> : detail.data && (
        <div className="space-y-5">
          <ErrorState error={detail.error} />
          <Card title={detail.data.purpose} subtitle={detail.data.description}
            actions={<>
              {detail.data.active_version !== null && <Button size="sm" disabled={!can} loading={busy === "builtin"} onClick={() => run("builtin", () => apiSend("post", `/prompts/${purpose}/activate`, { version: null }), "Back to the built-in instructions")}>Use built-in</Button>}
              <Button size="sm" variant="primary" disabled={!can || !(form.system.trim() || form.model.trim() || form.temperature)} loading={busy === "publish"}
                onClick={() => run("publish", () => apiSend("post", `/prompts/${purpose}`, { system: form.system, model: form.model, temperature: form.temperature === "" ? null : Number(form.temperature), note: form.note }), "Published and in use")}>Publish</Button>
            </>}>
            <div className="space-y-3">
              <Field label="Instructions" hint="Write {{default}} where the built-in instructions should go, to add to them instead of replacing them. Empty: built-in.">
                <Textarea rows={10} className="font-sans text-sm" value={form.system} disabled={!can} onChange={(e) => setForm({ ...form, system: e.target.value })} />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Model" hint="Empty: the default model."><Input value={form.model} disabled={!can} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
                <Field label="Temperature" hint="Empty: the default."><Input type="number" min={0} max={2} step="0.1" value={form.temperature} disabled={!can} onChange={(e) => setForm({ ...form, temperature: e.target.value })} /></Field>
                <Field label="Note"><Input value={form.note} disabled={!can} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
              </div>
            </div>
          </Card>
          <Card title="Built-in instructions"><pre className="scroll-thin max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{detail.data.default_system || "This purpose builds its instructions from the alert and settings at run time."}</pre></Card>
          {detail.data.versions.length > 0 && (
            <Card padded={false} title="Versions">
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{detail.data.versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                  <span className="font-medium">v{v.version}</span>{v.active && <Badge tone="emerald">in use</Badge>}
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{v.note || "no note"}, {v.created_by}, {fmtDateTime(v.created_at)}{v.model ? `, ${v.model}` : ""}</span>
                  {!v.active && <Button size="sm" disabled={!can} loading={busy === `a${v.version}`} onClick={() => run(`a${v.version}`, () => apiSend("post", `/prompts/${purpose}/activate`, { version: v.version }), `v${v.version} in use`)}>Use this</Button>}
                </li>))}</ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// -- safety -----------------------------------------------------------------------------------------------------------------
interface Safety { checks: { id: string; title: string; passed: boolean; severity: string; detail: string; fix: string }[]; passed: boolean; blocked: { ts: string; case_id: string | null; target?: string; check?: string; hits?: string[]; op?: string }[]; testing: { on: boolean; recipients: number }; stealth: boolean }

export function SafetyPanel() {
  const s = useApi<Safety>("/safety", undefined, 60_000);
  if (s.loading && !s.data) return <Spinner />;
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  if (!s.data) return null;
  return (
    <div className="space-y-5">
      {s.data.testing.on && <Alert tone="amber" title="Testing is on">Every email draft goes to {s.data.testing.recipients} stand-in recipient{s.data.testing.recipients === 1 ? "" : "s"} only.</Alert>}
      {s.data.stealth && <Alert tone="blue" title="The agent is silent in the Burson space">It reads and triages there but posts nothing.</Alert>}
      <Card padded={false} title={s.data.passed ? "Runtime checks pass" : "A blocking check fails"} subtitle="Run on every delivery. A failed blocking check holds outbound delivery." className={cx(!s.data.passed && "glow border-transparent dark:border-transparent")}
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={s.reload}>Run again</Button>}>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{s.data.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-3 px-5 py-3">
            {c.passed ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <CircleX className={cx("mt-0.5 size-4 shrink-0", c.severity === "blocker" ? "text-rose-500" : "text-amber-500")} />}
            <div className="min-w-0"><p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.title}</p><p className="text-xs text-zinc-500">{c.detail}</p>{!c.passed && c.fix && <p className="mt-0.5 text-xs text-zinc-800 dark:text-zinc-200">Fix: {c.fix}</p>}</div>
          </li>))}</ul>
      </Card>
      <Card padded={false} title="Messages held in the last 7 days" subtitle="Nothing here was posted.">
        {s.data.blocked.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-500">None.</p> : (
          <table className="w-full"><thead><tr><th className={TH}>When</th><th className={TH}>To</th><th className={TH}>Why</th><th className={TH}>Found</th><th className={TH}>Case</th></tr></thead>
            <tbody>{s.data.blocked.map((b, i) => (
              <tr key={i} className={TR}><td className={TD}>{fmtDateTime(b.ts)}</td><td className={TD}>{b.target}</td><td className={TD}>{(b.check ?? "").replace(/_/g, " ")}</td><td className={TD}>{(b.hits ?? []).join(", ")}</td>
                <td className={TD}>{b.case_id ? <Link className="text-blue-600 dark:text-blue-200" to={`/feed/${b.case_id}`}>{b.case_id}</Link> : ""}</td></tr>))}</tbody></table>
        )}
      </Card>
    </div>
  );
}

// -- costs ------------------------------------------------------------------------------------------------------------------
interface UsageRow { key: string; calls: number; errors: number; input_tokens: number; output_tokens: number; cost: number; p50_ms?: number | null }
interface Costs { ai: { currency: string; total: { calls: number; errors: number; input_tokens: number; output_tokens: number; cost: number; unpriced_calls: number }; by_purpose: UsageRow[]; by_model: UsageRow[]; by_day: UsageRow[] }; monthly_budget: number; billing: { currency: string; total: number; by_service: { service: string; cost: number }[] } | null; billing_error: string; priced_models: string[] }

export function CostsPanel() {
  const [days, setDays] = useState(7);
  const c = useApi<Costs>("/costs", { days });
  if (c.loading && !c.data) return <Spinner />;
  if (c.error) return <ErrorState error={c.error} onRetry={c.reload} />;
  if (!c.data) return null;
  const a = c.data.ai;
  const money = (n: number, cur = a.currency) => `${cur} ${n.toFixed(2)}`;
  const table = (title: string, rows: UsageRow[], first: string) => (
    <Card padded={false} title={title}>
      {rows.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-500">No Gemini calls in this period.</p> : (
        <table className="w-full"><thead><tr><th className={TH}>{first}</th><th className={TH}>Calls</th><th className={TH}>Failed</th><th className={TH}>Tokens in</th><th className={TH}>Tokens out</th><th className={TH}>Cost</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key} className={TR}><td className={TD}>{r.key}</td><td className={cx(TD, "tabular-nums")}>{fmtNum(r.calls)}</td><td className={cx(TD, "tabular-nums")}>{r.errors}</td><td className={cx(TD, "tabular-nums")}>{fmtNum(r.input_tokens)}</td><td className={cx(TD, "tabular-nums")}>{fmtNum(r.output_tokens)}</td><td className={cx(TD, "tabular-nums")}>{money(r.cost)}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
  return (
    <div className="space-y-5">
      <div className="flex justify-end"><Segmented label="Days" value={days} onChange={setDays} options={[1, 7, 30, 90].map((n) => ({ value: n, label: n === 1 ? "24 h" : `${n} days` }))} /></div>
      {a.total.unpriced_calls > 0 && <Alert tone="amber" title={`${a.total.unpriced_calls} calls used a model with no price`}>Add its price per million tokens above so the cost is counted. Priced now: {c.data.priced_models.join(", ") || "none"}.</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Gemini cost" value={money(a.total.cost)} hint={c.data.monthly_budget ? `budget ${money(c.data.monthly_budget)} a month` : "no budget set"} />
        <Stat label="Calls" value={fmtNum(a.total.calls)} hint={`${a.total.errors} failed`} tone={a.total.errors ? "amber" : undefined} />
        <Stat label="Tokens" value={fmtNum(a.total.input_tokens + a.total.output_tokens)} hint={`${fmtNum(a.total.input_tokens)} in, ${fmtNum(a.total.output_tokens)} out`} />
        <Stat label="Cloud bill" value={c.data.billing ? money(c.data.billing.total, c.data.billing.currency) : "n/a"} hint={c.data.billing ? "from the billing export" : c.data.billing_error || "name the billing export table above"} />
      </div>
      {table("By purpose", a.by_purpose, "Purpose")}
      {table("By model", a.by_model, "Model")}
      {c.data.billing && (
        <Card padded={false} title="Cloud bill by service">
          <table className="w-full"><thead><tr><th className={TH}>Service</th><th className={TH}>Cost</th></tr></thead>
            <tbody>{c.data.billing.by_service.map((r) => <tr key={r.service} className={TR}><td className={TD}>{r.service}</td><td className={cx(TD, "tabular-nums")}>{money(r.cost, c.data!.billing!.currency)}</td></tr>)}</tbody></table>
        </Card>
      )}
    </div>
  );
}

// -- audit log --------------------------------------------------------------------------------------------------------------
interface Entry { audit_id: string; ts: string; actor: string; surface: string; action: string; target_type: string; target_id: string; summary: string; status: string; case_id: string | null; detail: Record<string, unknown> }

export function AuditPanel() {
  const { me } = useApp();
  const [f, setF] = useState({ q: "", actor: "", surface: "", status: "", case_id: "", days: 7 });
  const [open, setOpen] = useState("");
  const a = useApi<{ entries: Entry[]; surfaces: string[]; statuses: string[]; count: number }>("/audit", { ...f, limit: 300 }, 60_000);
  const query = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== "").map(([k, v]) => [k, String(v)])).toString();
  return (
    <Card padded={false} title="Audit log" subtitle="Every action by the agent, in Chat and in the Console, with who made it."
      actions={me?.is_lead ? <a href={`/api/audit.csv?${query}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 dark:text-blue-200"><Download className="size-4" />Export CSV</a> : undefined}>
      <div className="flex flex-wrap gap-2 border-b border-zinc-100 p-4 dark:border-zinc-800">
        <Input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Search" aria-label="Search" className="w-48" />
        <Input value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} placeholder="Who" aria-label="Who" className="w-44" />
        <Input value={f.case_id} onChange={(e) => setF({ ...f, case_id: e.target.value })} placeholder="Case" aria-label="Case" className="w-32" />
        <Select value={f.surface} onChange={(e) => setF({ ...f, surface: e.target.value })} aria-label="Where" className="w-auto"><option value="">Anywhere</option>{(a.data?.surfaces ?? []).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</Select>
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Result" className="w-auto"><option value="">Any result</option>{(a.data?.statuses ?? []).map((s) => <option key={s}>{s}</option>)}</Select>
        <Segmented label="Days" value={f.days} onChange={(days) => setF({ ...f, days })} options={[1, 7, 30, 90].map((n) => ({ value: n, label: n === 1 ? "24 h" : `${n} d` }))} />
      </div>
      <ErrorState error={a.error} onRetry={a.reload} />
      {a.loading && !a.data ? <Spinner /> : !a.data?.entries.length ? <p className="px-5 py-8 text-center text-sm text-zinc-500">Nothing matches.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full"><thead><tr><th className={TH}>When</th><th className={TH}>Who</th><th className={TH}>Where</th><th className={TH}>What</th><th className={TH}>Result</th></tr></thead>
            <tbody>{a.data.entries.map((e) => (
              <tr key={e.audit_id} className={cx(TR, "cursor-pointer")} onClick={() => setOpen(open === e.audit_id ? "" : e.audit_id)}>
                <td className={cx(TD, "whitespace-nowrap")}>{fmtDateTime(e.ts)}</td><td className={TD}>{e.actor}</td><td className={TD}>{e.surface.replace(/_/g, " ")}</td>
                <td className={TD}><span className="break-words">{e.summary || e.action}</span>{e.case_id && <Link className="ml-2 text-blue-600 dark:text-blue-200" to={`/feed/${e.case_id}`} onClick={(ev) => ev.stopPropagation()}>{e.case_id}</Link>}
                  {open === e.audit_id && <CodeBlock className="mt-2" value={{ action: e.action, target: `${e.target_type} ${e.target_id}`.trim(), ...e.detail }} />}</td>
                <td className={TD}><Badge tone={e.status === "ok" ? "emerald" : e.status === "denied" || e.status === "blocked" ? "amber" : "rose"}>{e.status}</Badge></td>
              </tr>))}</tbody></table>
        </div>
      )}
      {a.data && <p className="px-5 py-3 text-xs text-zinc-500">{a.data.count} entries.</p>}
    </Card>
  );
}
