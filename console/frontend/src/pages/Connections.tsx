import { Bot, CircleCheck, CircleX, Cloud, Copy, Database, FolderOpen, KeyRound, Mail, Megaphone, MessagesSquare, Radar, Send, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { apiGet, apiSend, toApiError } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { Alert, Badge, Button, cx, Drawer, ErrorState, Field, Input, PageHeader, Select, Spinner, Toggle } from "../components/ui";
import { useApp } from "../context";
import { fmtRelative } from "../lib/format";

interface FieldRow { path: string; label: string; required: boolean; help: string; options: string; choices: string[]; value: string | null; set: boolean }
interface Detail { label: string; ok: boolean; message: string; row?: string }
interface Test { ok: boolean; message: string; details: Detail[]; grants: string[]; at: string; by: string }
type State = "connected" | "ready" | "incomplete" | "not_connected" | "failing";
interface Reads { key: string; temp_checks: boolean; early: boolean; watches: boolean; own: boolean }
/** A table the app reads. One row even when several settings name it. */
interface TableRow {
  id: string; name: string; what: string; table: string; set: boolean; location: string; post: Reads | null; reads: string[];
  status: { ok: boolean; message: string } | null;
}
interface Tool {
  key: string; name: string; what: string; required: boolean; uses: string[]; access: string; settings: string; create: string; fields: FieldRow[];
  missing: string[]; state: State; test: Test | null; facts: { label: string; value: string }[]; steps: { key: string; title: string }[];
  tables?: TableRow[];
}
interface Todo { tool: string; name: string; text: string; required: boolean }
interface Catalog {
  connections: Tool[]; backend: string; is_admin: boolean; todo: Todo[]; grants: string[];
  summary: { required: number; ready: number; connected: number; failing: number; total: number };
}
interface Filled { filled: { path: string; value: string; tool: string; label: string }[]; notes: string[] }
interface SetUp { filled: number; created: number; checked: number; connected: number; notes: string[] }

const ICON: Record<string, ReactNode> = {
  gcp: <Cloud />, gemini: <Sparkles />, runtime: <Bot />, chat: <MessagesSquare />, bigquery: <Database />, delivery: <Send />, secrets: <KeyRound />,
  gmail: <Mail />, drive: <FolderOpen />, brandwatch: <Radar />, campaigns: <Megaphone />,
};
const POST_READS: [keyof Omit<Reads, "key">, string][] = [["temp_checks", "Temp checks"], ["early", "Early Detection"], ["watches", "Watches"], ["own", "Agent alerts"]];

function stateOf(t: Tool): { label: string; tone: "emerald" | "blue" | "amber" | "zinc" | "rose" } {
  if (t.state === "connected") return { label: "Connected", tone: "emerald" };
  if (t.state === "ready") return { label: "Set, not checked", tone: "blue" };
  const failed = t.test?.details.filter((d) => !d.ok) ?? [];
  if (t.state === "failing" && failed.length > 0 && failed.every((d) => d.row)) {
    return { label: `${failed.length} ${failed.length === 1 ? "table" : "tables"} not readable`, tone: "rose" };
  }
  if (t.state === "failing") return { label: "Check failed", tone: "rose" };
  if (t.state === "incomplete") return { label: `Needs ${t.missing.length} ${t.missing.length === 1 ? "value" : "values"}`, tone: "amber" };
  return { label: "Not connected", tone: "zinc" };
}

function Tile({ tool, onOpen }: { tool: Tool; onOpen: () => void }) {
  const state = stateOf(tool);
  return (
    <button type="button" onClick={onOpen}
      className={cx("flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 text-left transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/60",
        tool.state === "failing" && "glow border-transparent dark:border-transparent")}>
      <span className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 [&>svg]:size-5">{ICON[tool.key]}</span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-zinc-950 dark:text-zinc-50">{tool.name}</span>
        <Badge tone={state.tone}>{state.label}</Badge>
      </span>
      <span className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{tool.what}</span>
      <span className="mt-3 text-sm font-medium text-blue-700 dark:text-blue-300">{tool.state === "not_connected" || tool.state === "incomplete" ? "Connect" : "Manage"}</span>
    </button>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="flex items-center gap-3 text-sm font-medium text-zinc-950 dark:text-zinc-50">
        <span className={cx("flex size-6 items-center justify-center rounded-full text-xs tabular-nums", done ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100")}>{n}</span>{title}
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

interface SignIn { signed_in: boolean; email: string; client_ready: boolean; scopes: string[] }

/** The QA chatbot signs in to Google Chat once, as its own account, so the Console can read and post there as it. */
function BotSignIn({ n, admin, onChanged }: { n: number; admin: boolean; onChanged: () => void }) {
  const { toast } = useApp();
  const [query, setQuery] = useSearchParams();
  const state = useApi<SignIn>("/chat-signin");
  const start = useAction(() => apiGet<{ auth_url: string }>("/chat-signin/connect", { format: "json" }));
  const out = useAction(() => apiSend<SignIn>("delete", "/chat-signin"));
  const result = query.get("signin");
  const reason = query.get("reason");
  useEffect(() => {
    if (result !== "connected") return;
    toast("The QA chatbot is signed in to Chat", "success");
    setQuery({}, { replace: true });
    onChanged();
  }, [result]);  // eslint-disable-line react-hooks/exhaustive-deps
  const s = state.data;
  return (
    <Step n={n} title="Sign in as the QA chatbot" done={!!s?.signed_in}>
      {result === "error" && <Alert tone="rose" className="mb-3" title="The sign-in did not finish">{reason}</Alert>}
      {(start.error ?? out.error) && <Alert tone="rose" className="mb-3">{(start.error ?? out.error)?.message}</Alert>}
      {!s ? <Spinner /> : s.signed_in ? (
        <>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">Signed in as {s.email}. The Console reads and posts in Chat as this account.</p>
          {admin && <Button className="mt-3" loading={out.loading} onClick={async () => { const r = await out.run(); if (r) { state.setData(r); onChanged(); } }}>Sign out</Button>}
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {s.email ? `Google will ask you to choose an account: choose ${s.email}. It is asked to let the QA chatbot read messages, post, add emoji reactions, and see spaces and their members.`
              : "Enter the QA chatbot's account above and save it first."}
          </p>
          {!s.client_ready && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">No Google sign-in client is set up yet. Create one once: the steps are at the top of infra/08_gmail_oauth.sh.</p>}
          {admin && <Button className="mt-3" variant="primary" loading={start.loading} disabled={!s.email || !s.client_ready}
            onClick={async () => { const r = await start.run(); if (r) window.location.href = r.auth_url; }}>Sign in as the QA chatbot</Button>}
        </>
      )}
    </Step>
  );
}

/** Lines for the owners of the data to run, with one Copy for all of them. */
function Grants({ lines, className }: { lines: string[]; className?: string }) {
  const { toast } = useApp();
  if (!lines.length) return null;
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Send to the owners of the data</p>
        <Button size="sm" icon={<Copy className="size-3.5" />}
          onClick={async () => { await navigator.clipboard.writeText(lines.join("\n")); toast(lines.length === 1 ? "Line copied" : `${lines.length} lines copied`, "success"); }}>Copy</Button>
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-100 p-3 font-mono text-xs text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200">{lines.join("\n")}</pre>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Each line lets this Console read one dataset. Check again once they have run them.</p>
    </div>
  );
}

/** What a check found beyond the row's badge: "Readable" is already on the badge. */
const said = (status: { ok: boolean; message: string }) => (status.ok ? status.message.replace(/^Readable\.\s*/, "") : status.message);

/** Every table the app reads, once: its id, what reads it, and what the last check found. */
function TablesStep({ n, rows, admin, onChanged }: { n: number; rows: TableRow[]; admin: boolean; onChanged: () => void }) {
  const { toast } = useApp();
  const [ids, setIds] = useState<Record<string, string>>({});
  const [reads, setReads] = useState<Record<string, Reads>>({});
  const saved = JSON.stringify(rows.map((r) => [r.id, r.table, r.post]));
  useEffect(() => { setIds({}); setReads({}); }, [saved]);  // what is typed stays through the page's refresh, and clears once it is saved
  const tables = rows.filter((r) => ids[r.id] !== undefined && ids[r.id].trim() !== r.table).map((r) => ({ id: r.id, table: ids[r.id].trim() }));
  const chosen = rows.flatMap((r) => {
    const now = r.post && reads[r.post.key];
    return r.post && now && POST_READS.some(([k]) => now[k] !== r.post?.[k]) ? [now] : [];
  });
  const save = useAction(() => apiSend("put", "/connections/bigquery/tables", { tables, reads: chosen }));
  const count = tables.length + chosen.length;
  return (
    <Step n={n} title="The tables it reads" done={rows.some((r) => r.status?.ok) && rows.every((r) => !r.status || r.status.ok)}>
      {save.error && <Alert tone="rose" className="mb-3">{save.error.message}</Alert>}
      <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.map((r) => {
          const now = r.post ? reads[r.post.key] ?? r.post : null;
          const others = r.reads.filter((x) => !POST_READS.some(([, label]) => label === x));
          return (
            <li key={r.id} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-zinc-950 dark:text-zinc-50">{r.name}</span>
                {!r.set ? <Badge tone="zinc">Not set</Badge> : r.status ? <Badge tone={r.status.ok ? "emerald" : "rose"}>{r.status.ok ? "Readable" : "Not readable"}</Badge>
                  : !r.reads.length ? <Badge tone="zinc">Nothing reads it</Badge> : null}
                {r.location && <span className="text-xs text-zinc-500 dark:text-zinc-400">in {r.location}</span>}
              </div>
              {r.what && <p className="mt-0.5 truncate text-sm text-zinc-600 dark:text-zinc-400" title={r.what}>{r.what}</p>}
              <Input className="mt-2 font-mono text-xs" aria-label={`${r.name} table`} placeholder="project.dataset.table" value={ids[r.id] ?? r.table} disabled={!admin}
                autoComplete="off" spellCheck={false} onChange={(e) => setIds((old) => ({ ...old, [r.id]: e.target.value }))} />
              {now && (
                <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">Read by</span>
                  {POST_READS.map(([k, label]) => <Toggle key={k} label={label} checked={now[k]} disabled={!admin} onChange={(v) => setReads((old) => ({ ...old, [now.key]: { ...now, [k]: v } }))} />)}
                </div>
              )}
              {others.length > 0 && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{now ? "Also read by" : "Read by"} {others.join(", ")}</p>}
              {r.status && said(r.status) && <p className={cx("mt-2 break-words text-sm", r.status.ok ? "text-zinc-600 dark:text-zinc-400" : "text-rose-700 dark:text-rose-300")}>{said(r.status)}</p>}
            </li>
          );
        })}
      </ul>
      {admin && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={!count} loading={save.loading}
            onClick={async () => { if (await save.run()) { toast("Tables saved", "success"); onChanged(); } }}>Save</Button>
          {count > 0 && <span className="text-sm text-zinc-500 dark:text-zinc-400">{count} changed</span>}
        </div>
      )}
      <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
        A table is set once here and changes everywhere it is used. Its location is read from BigQuery by the check. Add a table of posts under{" "}
        <Link to="/settings/temp_check" className="text-blue-700 hover:underline dark:text-blue-300">Settings, Temp check</Link>.
      </p>
    </Step>
  );
}

function ToolFlow({ tool, admin, onChanged }: { tool: Tool; admin: boolean; onChanged: () => void }) {
  const { toast } = useApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [lists, setLists] = useState<Record<string, { options: { value: string; label: string }[]; error: string }>>({});
  const [created, setCreated] = useState<{ step: string; ok: boolean; detail?: string }[] | null>(null);
  const [confirm, setConfirm] = useState(false);

  const saved = JSON.stringify(tool.fields.map((f) => [f.path, f.value]));
  useEffect(() => {
    setValues(Object.fromEntries(tool.fields.map((f) => [f.path, f.value === null || f.value === undefined ? "" : String(f.value)])));
    setCreated(null);
    setConfirm(false);
  }, [tool.key, saved]);  // eslint-disable-line react-hooks/exhaustive-deps -- what is typed stays through the page's refresh
  useEffect(() => {
    if (!admin) return;
    let live = true;
    tool.fields.filter((f) => f.options).forEach((f) => {
      apiGet<{ options: { value: string; label: string }[]; error: string }>(`/connections/${tool.key}/options`, { field: f.path })
        .then((r) => { if (live) setLists((old) => ({ ...old, [f.path]: r })); })
        .catch(() => undefined);
    });
    return () => { live = false; };
  }, [tool.key, admin]);  // eslint-disable-line react-hooks/exhaustive-deps

  const changed = tool.fields.filter((f) => (values[f.path] ?? "") !== (f.value === null || f.value === undefined ? "" : String(f.value)));
  const save = useAction(() => apiSend("put", `/connections/${tool.key}`, { values: Object.fromEntries(changed.map((f) => [f.path, values[f.path]])) }));
  const check = useAction(() => apiSend<{ test: Test }>("post", `/connections/${tool.key}/test`));
  const create = useAction(() => apiSend<{ ok: boolean; steps: { step: string; ok: boolean; detail?: string }[] }>("post", tool.create.replace(/^\/api/, "")));
  const cut = useAction(() => apiSend("delete", `/connections/${tool.key}`));
  const [result, setResult] = useState<Test | null>(null);
  useEffect(() => setResult(null), [tool.key]);
  const test = result ?? tool.test;
  // The tool itself answers; a table it reads may still need access.
  const works = !!test && (test.ok || (test.details.length > 0 && test.details.every((d) => d.ok || d.row)));
  const error = save.error ?? check.error ?? create.error ?? cut.error;
  let n = 0;

  const input = (f: FieldRow) => {
    const list = lists[f.path];
    const value = values[f.path] ?? "";
    const set = (v: string) => setValues((old) => ({ ...old, [f.path]: v }));
    if (f.choices.length) return <Select value={value} onChange={(e) => set(e.target.value)} disabled={!admin}>{f.choices.map((c) => <option key={c} value={c}>{c}</option>)}</Select>;
    if (list?.options.length) {
      return (
        <Select value={value} onChange={(e) => set(e.target.value)} disabled={!admin}>
          <option value="">Choose one</option>
          {value && !list.options.some((o) => o.value === value) && <option value={value}>{value}</option>}
          {list.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      );
    }
    return <Input value={value} onChange={(e) => set(e.target.value)} disabled={!admin} autoComplete="off" spellCheck={false} />;
  };
  const hint = (f: FieldRow) => {
    const list = lists[f.path];
    if (f.options && list && !list.options.length) return [f.help, list.error ? `Could not list them: ${list.error}` : "None found in the project: type it."].filter(Boolean).join(" ");
    return f.help || undefined;
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{tool.what} Used by: {tool.uses.join(", ")}.</p>
      {error && <Alert tone="rose">{error.message}</Alert>}
      {!admin && <Alert tone="blue">An admin connects and changes integrations. You can see their state here.</Alert>}
      {tool.fields.length > 0 && tool.facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-4 text-sm">
          {tool.facts.map((f) => <div key={f.label}><dt className="text-xs text-zinc-500 dark:text-zinc-400">{f.label}</dt><dd className="mt-0.5 text-zinc-900 dark:text-zinc-100">{f.value}</dd></div>)}
        </dl>
      )}

      {tool.fields.length > 0 ? (
        <Step n={++n} title={tool.steps[0]?.title ?? "Its values"} done={!tool.missing.length}>
          <div className="grid gap-4 sm:grid-cols-2">
            {tool.fields.filter((f) => f.required).map((f) => <Field key={f.path} label={f.label} hint={hint(f)}>{input(f)}</Field>)}
          </div>
          {tool.fields.some((f) => !f.required) && (
            <details className="mt-4" open={tool.fields.every((f) => !f.required)}>
              <summary className="cursor-pointer text-sm text-zinc-600 dark:text-zinc-400">Optional</summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {tool.fields.filter((f) => !f.required).map((f) => <Field key={f.path} label={f.label} hint={hint(f)}>{input(f)}</Field>)}
              </div>
            </details>
          )}
          {admin && (
            <div className="mt-4 flex items-center gap-3">
              <Button variant="primary" disabled={!changed.length} loading={save.loading}
                onClick={async () => { if (await save.run()) { toast(`${tool.name} saved`, "success"); setResult(null); onChanged(); } }}>Save</Button>
              {changed.length > 0 && <span className="text-sm text-zinc-500 dark:text-zinc-400">{changed.length} changed</span>}
            </div>
          )}
        </Step>
      ) : (
        <Step n={++n} title={tool.steps[0]?.title ?? "People"} done={tool.state === "connected"}>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            {tool.facts.map((f) => <div key={f.label}><dt className="text-xs text-zinc-500 dark:text-zinc-400">{f.label}</dt><dd className="mt-0.5 text-zinc-900 dark:text-zinc-100">{f.value}</dd></div>)}
          </dl>
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{tool.access} <Link to="/admin" className="text-blue-700 hover:underline dark:text-blue-300">See who is connected</Link></p>
        </Step>
      )}

      {tool.steps.some((x) => x.key === "signin") && <BotSignIn n={++n} admin={admin} onChanged={onChanged} />}

      {tool.create && (
        <Step n={++n} title="Create what is missing" done={!!created?.every((s) => s.ok)}>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">The Console creates what {tool.name} needs under the names above. What already exists is left alone.</p>
          {admin && <Button className="mt-3" loading={create.loading} disabled={!!tool.missing.length || changed.length > 0}
            onClick={async () => { const r = await create.run(); if (r) { setCreated(r.steps); onChanged(); } }}>Create</Button>}
          {created && <ul className="mt-3 flex flex-col gap-1 text-sm">{created.map((s) => <li key={s.step} className="flex items-start gap-2">{s.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-rose-600" />}<span>{s.step}{s.detail ? `: ${s.detail}` : ""}</span></li>)}</ul>}
        </Step>
      )}

      {tool.tables && <TablesStep n={++n} rows={tool.tables} admin={admin} onChanged={() => { setResult(null); onChanged(); }} />}

      <Step n={++n} title="Check access" done={works}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Needs: {tool.access}</p>
        {admin && <Button className="mt-3" variant={test?.ok ? "secondary" : "primary"} loading={check.loading} disabled={changed.length > 0}
          onClick={async () => { const r = await check.run(); if (r) { setResult(r.test); onChanged(); } }}>{test ? "Check again" : "Check now"}</Button>}
        {test && (
          <div className="mt-4">
            <p className={cx("text-sm font-medium", works ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300")}>{works ? "Connected" : "Not connected yet"}<span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">checked {fmtRelative(test.at)}</span></p>
            {!test.details.length && <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{test.message}</p>}
            {tool.tables && test.details.some((d) => d.row) && (
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
                {test.details.filter((d) => d.row && d.ok).length} of {test.details.filter((d) => d.row).length} tables are readable. Each table's line is in the list above.
              </p>
            )}
            <ul className="mt-2 flex flex-col gap-2">
              {test.details.filter((d) => !d.row).map((d) => (
                <li key={d.label} className="flex items-start gap-2 text-sm">
                  {d.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />}
                  <span className="min-w-0"><span className="font-medium text-zinc-900 dark:text-zinc-100">{d.label}</span><span className="block break-words text-zinc-600 dark:text-zinc-400">{d.message}</span></span>
                </li>
              ))}
            </ul>
            <Grants lines={test.grants ?? []} className="mt-4" />
          </div>
        )}
      </Step>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {tool.settings && <Link to={tool.settings} className="text-blue-700 hover:underline dark:text-blue-300">More settings for {tool.name}</Link>}
        {admin && !tool.required && tool.fields.length > 0 && tool.state !== "not_connected" && (confirm ? (
          <span className="flex items-center gap-2">Its values go back to their defaults.
            <Button size="sm" onClick={() => setConfirm(false)}>Keep</Button>
            <Button size="sm" variant="danger" loading={cut.loading} onClick={async () => { if (await cut.run()) { toast(`${tool.name} disconnected`, "success"); setConfirm(false); onChanged(); } }}>Disconnect</Button>
          </span>
        ) : <button type="button" onClick={() => setConfirm(true)} className="text-zinc-600 hover:underline dark:text-zinc-400">Disconnect</button>)}
      </div>
    </div>
  );
}

/** What is left for a person across every tool, and the lines to send to the owners of the data. */
function LeftToDo({ todo, grants, onOpen }: { todo: Todo[]; grants: string[]; onOpen: (key: string) => void }) {
  if (!todo.length) return null;
  const needed = todo.filter((t) => t.required);
  return (
    <section className="mb-7 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-950 dark:text-zinc-50">Left to do <span className="ml-1 font-normal tabular-nums text-zinc-500 dark:text-zinc-400">{todo.length}</span></h2>
      <ul className="mt-3 flex flex-col gap-2.5">
        {[...needed, ...todo.filter((t) => !t.required)].map((t) => (
          <li key={`${t.tool}:${t.text}`} className="flex items-start gap-3 text-sm">
            <button type="button" onClick={() => onOpen(t.tool)} className="w-36 shrink-0 text-left font-medium text-blue-700 hover:underline dark:text-blue-300">{t.name}</button>
            <span className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{t.text}</span>
          </li>
        ))}
      </ul>
      <Grants lines={grants} className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800" />
    </section>
  );
}

export default function ConnectionsPage() {
  const { toolKey } = useParams();
  const navigate = useNavigate();
  const data = useApi<Catalog>("/connections", undefined, 60_000);
  const [step, setStep] = useState("");
  const [done, setDone] = useState<SetUp | null>(null);
  const tools = data.data?.connections ?? [];
  const open = tools.find((t) => t.key === toolKey) ?? null;
  const admin = !!data.data?.is_admin;
  const sum = data.data?.summary;
  const groups: [string, Tool[]][] = [["Needed for the agent to work", tools.filter((t) => t.required)], ["Optional", tools.filter((t) => !t.required)]];

  /** One press: fill what the service can see, create what the needed tools are missing, then check every tool that has its values. */
  const setUp = useAction(async () => {
    setDone(null);
    const notes: string[] = [];
    let created = 0;
    let checked = 0;
    try {
      setStep("Finding values");
      const found = await apiSend<Filled & Catalog>("post", "/connections/autofill");
      notes.push(...found.notes);
      const set = found.connections.filter((t) => !t.missing.length);
      if (found.backend !== "local") {
        for (const t of set.filter((x) => x.required && x.create)) {
          setStep(`Creating what ${t.name} needs`);
          try {
            const made = await apiSend<{ steps: { detail?: string; name?: string }[] }>("post", t.create.replace(/^\/api/, ""));
            created += made.steps.filter((x) => x.name && x.detail === "created").length;
          } catch (err) { notes.push(`${t.name}: ${toApiError(err).message}`); }
        }
        for (const t of set) {
          setStep(`Checking ${t.name}, ${checked + 1} of ${set.length}`);
          try { await apiSend("post", `/connections/${t.key}/test`); } catch (err) { notes.push(`${t.name}: ${toApiError(err).message}`); }
          checked += 1;
        }
      }
      const after = await apiGet<Catalog>("/connections");
      data.setData(after);
      setDone({ filled: found.filled.length, created, checked, connected: after.summary.connected, notes });
    } finally { setStep(""); }
  });

  return (
    <div>
      <PageHeader title="Integrations" description={step ? `${step}…` : sum ? `${sum.ready} of ${sum.required} needed tools are set · ${sum.connected} checked and connected` : undefined}
        actions={admin ? <Button variant="primary" loading={setUp.loading} onClick={() => void setUp.run()}>Set up</Button> : undefined} />
      <ErrorState error={data.error ?? setUp.error} onRetry={data.reload} />
      {done && (
        <Alert tone={data.data?.todo.length ? "blue" : "emerald"} className="mb-4"
          title={[`Filled ${done.filled} ${done.filled === 1 ? "value" : "values"}`, done.created ? `created ${done.created} ${done.created === 1 ? "table" : "tables"}` : "", done.checked ? `checked ${done.checked} tools, ${done.connected} connected` : ""].filter(Boolean).join(" · ")}>
          {done.notes.map((note) => <p key={note}>{note}</p>)}
        </Alert>
      )}
      {data.data && <LeftToDo todo={data.data.todo} grants={data.data.grants} onOpen={(key) => navigate(`/connections/${key}`)} />}
      {data.loading && !data.data ? <Spinner /> : groups.map(([title, list]) => list.length > 0 && (
        <section key={title} className="mb-7">
          <h2 className="mb-3 text-sm font-medium text-zinc-600 dark:text-zinc-400">{title}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{list.map((t) => <Tile key={t.key} tool={t} onOpen={() => navigate(`/connections/${t.key}`)} />)}</div>
        </section>
      ))}
      <Drawer open={!!open} onClose={() => navigate("/connections")}
        title={open ? <span className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 [&>svg]:size-5">{ICON[open.key]}</span><span className="text-base font-medium text-zinc-950 dark:text-zinc-50">{open.name}</span><Badge tone={stateOf(open).tone}>{stateOf(open).label}</Badge></span> : ""}>
        {open && <ToolFlow tool={open} admin={admin} onChanged={data.reload} />}
      </Drawer>
    </div>
  );
}
