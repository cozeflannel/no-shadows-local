import { BookOpen, Download, FileSpreadsheet, Link2, PenLine, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { apiGet, apiSend, http, toApiError, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { KnowledgeImportModal } from "../components/SheetImport";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, Modal, OffNotice, PageHeader, Select, Spinner, Stat, Tabs, TD, TH, TR, Toggle } from "../components/ui";
import { useApp } from "../context";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

// The editor is loaded when a document is opened, so the rest of the Console stays light.
const DocEditor = lazy(() => import("../components/DocEditor").then((m) => ({ default: m.DocEditor })));

type Tab = "docs" | "classes" | "search" | "golden";
interface Doc { doc_id: string; title: string; source_type: "text" | "url" | "drive"; link: string; covers: string; kind: "document" | "guidance"; tags: string[]; classes: string[]; external_ok: boolean; enabled: boolean; status: string; status_detail: string; chars: number; chunks: number; embedded: boolean; version: number; fetched_at: string | null; updated_at: string | null; updated_by: string; imported_from?: string; text_from?: string }
interface ClassRow { name: string; description: string; knowledge_tags: string[]; docs: string[] }
interface KnowledgeList { docs: Doc[]; classes: ClassRow[]; classes_from_settings: boolean; switches: { knowledge_rag: boolean; classification_layer: boolean }; retrieval: { embedding_model: string; top_k: number }; can_edit: boolean; can_import?: boolean }
interface Passage { ref: string; doc_id: string; title: string; link: string; kind: string; text: string; score: number }
interface Golden { stats: { total: number; by_label: Record<string, number>; labelled: number; agreement_rate: number | null; assessments: { agree: number; disagree: number }; most_corrected_fields: [string, number][] }; records: { case_id: string; label: string; agent: { verdict?: string }; expected: { verdict?: string }; updated_at: string; assessments: unknown[] }[]; capture_on: boolean }

const FORMATS: { value: "docx" | "html" | "txt"; label: string }[] = [{ value: "docx", label: "Word" }, { value: "html", label: "Web page" }, { value: "txt", label: "Text" }];
const UPLOADS = ".docx,.pdf,.html,.htm,.md,.txt";
const hasWords = (html: string) => html.replace(/<[^>]+>/g, "").trim().length > 0;
const EMPTY = { doc_id: "", title: "", source_type: "text" as Doc["source_type"], link: "", html: "", editable: true, covers: "", kind: "document" as Doc["kind"], tags: "", classes: [] as string[], external_ok: false, enabled: true };
// A document's status in plain words: ready to be read by the agent, not read yet, or failing (its detail says why)
const STATUS: Record<string, { label: string; tone: "emerald" | "rose" | "zinc" }> = { ready: { label: "Ready", tone: "emerald" }, pending: { label: "Not read yet", tone: "zinc" }, error: { label: "Can't be read", tone: "rose" } };
const SOURCE_LABEL: Record<Doc["source_type"], string> = { text: "written here", url: "web page", drive: "Drive file" };

function DocsTab({ data, reload }: { data: KnowledgeList; reload: () => void }) {
  const { toast } = useApp();
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [importing, setImporting] = useState(false);
  const edit = async (d: Doc) => {
    setError(null);
    try {
      const full = await apiGet<{ doc: Doc; text: string; html: string; editable: boolean }>(`/knowledge/${d.doc_id}`);
      setForm({ doc_id: d.doc_id, title: d.title, source_type: d.source_type, link: d.link, html: full.html, editable: full.editable, covers: d.covers, kind: d.kind, tags: d.tags.join(", "), classes: d.classes, external_ok: d.external_ok, enabled: d.enabled });
    } catch (err) { toast((err as ApiError).message, "error"); }
  };
  const save = async () => {
    if (!form) return;
    setBusy("save"); setError(null);
    try {
      await apiSend("post", "/knowledge", { ...form, editable: undefined, doc_id: form.doc_id || undefined, html: form.source_type === "text" ? form.html : undefined, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) });
      toast("Saved and indexed"); setForm(null); reload();
    } catch (err) { setError(err as ApiError); } finally { setBusy(""); }
  };
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast(done); reload(); } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const picker = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("upload");
    let added = 0;
    for (const file of Array.from(files)) {
      try {
        await http.post("/knowledge/upload", file, { params: { filename: file.name }, headers: { "Content-Type": "application/octet-stream" } });
        added += 1;
      } catch (err) { toast(`${file.name}: ${toApiError(err).message}`, "error"); }
    }
    if (picker.current) picker.current.value = "";
    setBusy("");
    if (added) { toast(added === 1 ? "Uploaded and indexed" : `${added} documents uploaded and indexed`); reload(); }
  };
  return (
    <>
      <Card padded={false} title="Documents" subtitle="What the agent reads before it assesses an alert or answers a question. Guidance outranks documents."
        actions={<div className="flex flex-wrap items-center justify-end gap-2">
          <input ref={picker} type="file" multiple accept={UPLOADS} className="sr-only" aria-label="Upload documents" onChange={(e) => void upload(e.target.files)} />
          {data.can_import && <Button icon={<FileSpreadsheet className="size-4" />} onClick={() => setImporting(true)}>Bring over from the sheet</Button>}
          <Button variant="primary" icon={<Upload className="size-4" />} disabled={!data.can_edit} loading={busy === "upload"} onClick={() => picker.current?.click()}>Upload</Button>
          <Button icon={<PenLine className="size-4" />} disabled={!data.can_edit} onClick={() => { setError(null); setForm(EMPTY); }}>Write one</Button>
          <Button icon={<Link2 className="size-4" />} disabled={!data.can_edit} onClick={() => { setError(null); setForm({ ...EMPTY, source_type: "url" }); }}>Link one</Button>
          {data.docs.length > 0 && (
            <Select aria-label="Export every document" className="w-36" value="" onChange={(e) => { if (e.target.value) window.location.assign(`/api/knowledge-export?format=${e.target.value}`); }}>
              <option value="">Export all</option>{FORMATS.map((f) => <option key={f.value} value={f.value}>As {f.label}</option>)}
            </Select>
          )}
        </div>}>
        {data.docs.length === 0 ? <EmptyState icon={<BookOpen className="size-8" />} title="No documents yet">{data.can_import ? "Bring over the sheet's documents, or upload" : "Upload"} a Word file, a PDF, a web page, Markdown or text. Or write one here, or link a web page or a Drive file.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full"><thead><tr><th className={TH}>Document</th><th className={TH}>Classes</th><th className={TH}>Size</th><th className={TH}>Status</th><th className={TH}>Updated</th><th className={TH} /></tr></thead>
              <tbody>{data.docs.map((d) => (
                <tr key={d.doc_id} className={cx(TR, !d.enabled && "opacity-60")}>
                  <td className={TD}>
                    <button type="button" className="text-left font-medium text-blue-600 hover:underline dark:text-blue-200" onClick={() => edit(d)}>{d.title}</button>
                    <span className="block text-xs text-zinc-500">{d.doc_id} {d.kind === "guidance" ? "guidance" : SOURCE_LABEL[d.source_type] ?? d.source_type}{d.imported_from === "sheet" ? ", from the sheet" : d.imported_from === "folder" ? ", from a file" : ""}{!d.enabled ? ", off" : ""}</span>
                  </td>
                  <td className={TD}>{d.classes.length ? d.classes.join(", ") : <span className="text-zinc-500">all</span>}</td>
                  <td className={cx(TD, "tabular-nums")}>{fmtNum(d.chars)} chars, {d.chunks} parts{d.embedded ? ", embedded" : ""}</td>
                  <td className={TD}><Badge tone={STATUS[d.status]?.tone ?? "zinc"}>{STATUS[d.status]?.label ?? d.status}</Badge>{d.status_detail && <span className="block max-w-56 truncate text-xs text-zinc-500" title={d.status_detail}>{d.status_detail}</span>}</td>
                  <td className={TD}>{fmtRelative(d.updated_at)}<span className="block text-xs text-zinc-500">{d.updated_by} v{d.version}</span></td>
                  <td className={cx(TD, "whitespace-nowrap text-right")}>
                    <Select aria-label={`Download ${d.title}`} className="mr-1 inline-block w-32 align-middle" value=""
                      onChange={(e) => { if (e.target.value) window.location.assign(`/api/knowledge/${d.doc_id}/export?format=${e.target.value}`); }}>
                      <option value="">Download</option>{FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </Select>
                    {d.source_type !== "text" && <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} disabled={!data.can_edit} loading={busy === `r-${d.doc_id}`} onClick={() => act(`r-${d.doc_id}`, () => apiSend("post", `/knowledge/${d.doc_id}/refresh`), "Fetched again")}>Fetch</Button>}
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={!data.can_edit} loading={busy === `d-${d.doc_id}`}
                      onClick={() => { if (window.confirm(`Remove "${d.title}"? The agent stops reading it at once.`)) void act(`d-${d.doc_id}`, () => apiSend("delete", `/knowledge/${d.doc_id}`), "Removed"); }}>Remove</Button>
                  </td>
                </tr>))}</tbody></table>
          </div>
        )}
      </Card>
      {data.can_import && <KnowledgeImportModal open={importing} onClose={() => setImporting(false)} onDone={reload} />}
      <Modal open={!!form} wide title={form?.doc_id ? "Edit document" : "Add a document"} onClose={() => setForm(null)}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={busy === "save"} disabled={!form?.title.trim() || (form.source_type === "text" ? !hasWords(form.html) : !form.link.trim())} onClick={save}>Save and index</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorState error={error} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_10rem]">
              <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="Source"><Select value={form.source_type} onChange={(e) => setForm({ ...form, source_type: e.target.value as Doc["source_type"] })}><option value="text">Written here</option><option value="url">Web page</option><option value="drive">Drive file</option></Select></Field>
              <Field label="Kind"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Doc["kind"] })}><option value="document">Document</option><option value="guidance">Guidance</option></Select></Field>
            </div>
            {form.source_type === "text" ? <Suspense fallback={<Spinner label="Opening the editor…" />}><DocEditor key={form.doc_id || "new"} html={form.html} onChange={(html) => setForm((f) => (f ? { ...f, html } : f))} /></Suspense>
              : <Field label={form.source_type === "url" ? "Link to the page" : "Link to the Doc, Sheet or Slides file"} hint={form.source_type === "drive" ? "Share the file with the agent's account first." : undefined}><Input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} /></Field>}
            <Field label="What it covers" hint="One line the agent sees next to the title."><Input value={form.covers} onChange={(e) => setForm({ ...form, covers: e.target.value })} /></Field>
            <Field label="Classes that read it" hint="None ticked: every class reads it.">
              <div className="flex flex-wrap gap-x-4 gap-y-2">{data.classes.map((c) => <Toggle key={c.name} label={c.name} checked={form.classes.includes(c.name)} onChange={(on) => setForm({ ...form, classes: on ? [...form.classes, c.name] : form.classes.filter((x) => x !== c.name) })} />)}</div>
            </Field>
            <Field label="Tags" hint="Comma separated. A class can read by tag."><Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-6">
              <Toggle label="In use" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function SearchTab({ classes }: { classes: ClassRow[] }) {
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("");
  const [result, setResult] = useState<Passage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try { setResult((await apiSend<{ passages: Passage[] }>("post", "/knowledge/search", { query, label: label || undefined, external: false })).passages); }
    catch (err) { setError(err as ApiError); } finally { setBusy(false); }
  };
  return (
    <Card title="Try a search" subtitle="What the agent would read for a question or an alert.">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <Field label="Question or alert text" className="min-w-64 flex-1"><Input value={query} onChange={(e) => setQuery(e.target.value)} /></Field>
        <Field label="As class"><Select value={label} onChange={(e) => setLabel(e.target.value)}><option value="">Any</option>{classes.map((c) => <option key={c.name}>{c.name}</option>)}</Select></Field>
        <Button type="submit" variant="primary" icon={<Search className="size-4" />} loading={busy} disabled={!query.trim()}>Search</Button>
      </form>
      <ErrorState error={error} />
      {result && (result.length === 0 ? <p className="mt-4 text-sm text-zinc-500">Nothing would be read for this.</p> : (
        <ol className="mt-4 space-y-3">{result.map((p, i) => (
          <li key={`${p.ref}-${i}`} className="rounded-xl bg-zinc-100 p-3 dark:bg-zinc-950">
            <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500"><span className="font-medium text-zinc-800 dark:text-zinc-200">{p.title}</span><Badge tone={p.kind === "guidance" ? "violet" : p.kind === "case" ? "blue" : "zinc"}>{p.kind}</Badge>{p.ref}<span className="tabular-nums">score {p.score.toFixed(2)}</span></p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{p.text}</p>
          </li>))}</ol>
      ))}
    </Card>
  );
}

function GoldenTab() {
  const g = useApi<Golden>("/golden");
  if (g.loading && !g.data) return <Spinner />;
  if (g.error) return <ErrorState error={g.error} onRetry={g.reload} />;
  if (!g.data) return null;
  const s = g.data.stats;
  return (
    <div className="space-y-5">
      {!g.data.capture_on && <OffNotice what="Capturing every case as an example" flag="golden_set_capture">Assessments made in the review feed are always kept.</OffNotice>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Examples" value={fmtNum(s.total)} hint={`${s.labelled} labelled`} />
        <Stat label="Agent confirmed" value={fmtNum(s.by_label.confirmed ?? 0)} />
        <Stat label="Agent corrected" value={fmtNum(s.by_label.corrected ?? 0)} />
        <Stat label="Agreement" value={s.agreement_rate === null ? "n/a" : `${Math.round(s.agreement_rate * 100)}%`} hint={`${s.assessments.agree} right, ${s.assessments.disagree} wrong`} />
        <Stat label="Most corrected" value={<span className="text-xl">{s.most_corrected_fields[0]?.[0] ?? "none"}</span>} hint={s.most_corrected_fields[0] ? `${s.most_corrected_fields[0][1]} times` : ""} />
      </div>
      <Card padded={false} title="Examples" actions={<a href="/api/golden/export.yaml" className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 dark:text-blue-200"><Download className="size-4" />Export for evals</a>}>
        {g.data.records.length === 0 ? <p className="px-5 py-6 text-sm text-zinc-500">No examples yet. Answer "Was the agent right?" on an alert in the review feed.</p> : (
          <table className="w-full"><thead><tr><th className={TH}>Case</th><th className={TH}>Label</th><th className={TH}>Agent said</th><th className={TH}>Should be</th><th className={TH}>Updated</th></tr></thead>
            <tbody>{g.data.records.map((r) => (
              <tr key={r.case_id} className={TR}><td className={TD}><Link className="text-blue-600 dark:text-blue-200" to={`/feed/${r.case_id}`}>{r.case_id}</Link></td>
                <td className={TD}><Badge tone={r.label === "confirmed" ? "emerald" : r.label === "corrected" ? "blue" : "zinc"}>{r.label}</Badge></td>
                <td className={TD}>{r.agent.verdict ?? ""}</td><td className={TD}>{r.expected.verdict ?? ""}</td><td className={TD}>{fmtDateTime(r.updated_at)}</td></tr>))}</tbody></table>
        )}
      </Card>
    </div>
  );
}

export default function KnowledgePage() {
  const [search, setSearch] = useSearchParams();
  const tab = (search.get("tab") as Tab) || "docs";
  const k = useApi<KnowledgeList>("/knowledge");
  return (
    <div>
      <PageHeader title="Knowledge" actions={<Link to="/learning" className="text-sm font-medium text-blue-600 dark:text-blue-200">Proposed rules and facts</Link>} />
      <Tabs<Tab> value={tab} onChange={(t) => setSearch(t === "docs" ? {} : { tab: t }, { replace: true })}
        tabs={[{ key: "docs", label: "Documents", count: k.data?.docs.length }, { key: "classes", label: "Classes" }, { key: "search", label: "Try a search" }, { key: "golden", label: "Golden set" }]} />
      <ErrorState error={k.error} onRetry={k.reload} />
      {k.loading && !k.data ? <Spinner /> : k.data && <>
        {tab !== "golden" && !k.data.switches.knowledge_rag && <OffNotice what="Reading documents during triage and answers" flag="knowledge_rag">Documents are stored and searchable here, but the agent does not read them yet.</OffNotice>}
        {tab === "docs" && <DocsTab data={k.data} reload={k.reload} />}
        {tab === "classes" && (
          <Card padded={false} title="Classes and what each one reads" subtitle={k.data.classes_from_settings ? undefined : "No classes are set, so the exposure tag categories are used."}
            actions={<Link to="/settings/classification" className="text-sm font-medium text-blue-600 dark:text-blue-200">Edit classes</Link>}>
            {!k.data.switches.classification_layer && <Alert tone="blue" className="m-5 mb-0" title="The classification layer is switched off">Alerts are assessed without a class until an admin turns it on under Settings, Switches.</Alert>}
            <table className="w-full"><thead><tr><th className={TH}>Class</th><th className={TH}>Reads by tag</th><th className={TH}>Documents</th></tr></thead>
              <tbody>{k.data.classes.map((c) => (
                <tr key={c.name} className={TR}><td className={TD}><span className="font-medium">{c.name}</span><span className="block text-xs text-zinc-500">{c.description}</span></td>
                  <td className={TD}>{c.knowledge_tags.join(", ")}</td>
                  <td className={TD}>{c.docs.length ? c.docs.map((id) => k.data!.docs.find((d) => d.doc_id === id)?.title ?? id).join(", ") : <span className="text-zinc-500">every document</span>}</td></tr>))}</tbody></table>
          </Card>
        )}
        {tab === "search" && <SearchTab classes={k.data.classes} />}
      </>}
      {tab === "golden" && <GoldenTab />}
    </div>
  );
}
