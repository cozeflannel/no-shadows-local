import { Search, Sparkles, Thermometer } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { apiGet, apiSend, type ApiError } from "../api/client";
import { fmtDateTime, fmtNum } from "../lib/format";
import { Badge, Button, Card, cx, Field, Input, Segmented, Select, Textarea, Toggle } from "./ui";

/** What the form needs to know from Settings: the tables that can be searched and the numbers its labels name. */
export interface FormInfo {
  tables: { key: string; label: string; freshness: string; what: string }[]; platforms: string[];
  spike_mentions: number; no_query_hours: number; since_max_days: number; event_query_prefix: string;
}
export interface PastCheck { check_id: string; issue: string; created_at: string; own_posts: number; own_from: string | null }
/** What the converter made of a query, as the temp check app reports it. A temp check kept from before the converter matched the app's has `case_sensitive` and notes with no clause. */
export interface ConvertResult {
  boolean: string; origin: string; ok: boolean; error: string;
  report: { summary?: { terms: number; phrases: number; near: number; wildcards: number; caseSensitive?: number; case_sensitive?: number };
    notes?: { status: string; clause?: string; note: string; effect: string }[]; warnings?: string[] } | null;
  estimate?: Record<string, { bytes?: number; skip?: string }>; window?: { from: string; to: string }; sql?: { table: string; sql: string }[];
}
interface QueryRow { id: number; name: string; created: string | null; state: string }
interface Picked { ref: string; name: string; id?: number; created?: string | null; boolean?: string; error?: string }
interface Step { at: string; text: string }
interface Progress { check_id: string; status: string; steps: Step[]; error: string; started_at: string | null }
interface Needs { choices: QueryRow[]; near: QueryRow[]; missing: number }
interface RunResult { needs?: Needs; check?: { check_id: string; status: string; error: string; query?: { choices?: { id: number; name: string }[] } } | null; data?: { user_error?: string } }

const ORIGIN: Record<string, string> = {
  typed: "the query you typed", filters: "the filters, written as a query", query: "the Brandwatch query's own Boolean",
  kept: "the query the earlier temp check used", drafted: "the drafted query",
};
const gb = (bytes: number) => `${(bytes / 1073741824).toFixed(bytes > 107374182 ? 1 : 2)} GB`;
const plural = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const looksLikeId = (text: string) => /\d{9,12}/.test(text) && /^(https?:|\d+$)/.test(text);
const seconds = (from: number, to: number) => Math.max(0, Math.round((to - from) / 1000));
const pre = "scroll-thin max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100 p-3 font-mono text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 rounded-2xl border border-zinc-200 px-3.5 pb-3.5 pt-1.5 dark:border-zinc-800">
      <legend className="px-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">{legend}</legend>
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

function Radio({ name, checked, onChange, disabled, children }: { name: string; checked: boolean; onChange: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <label className={cx("flex select-none items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <input type="radio" name={name} className="mt-0.5 size-4 shrink-0 accent-blue-600" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/** How a query converts to a search of our tables: what was read, what was approximated or left out, what it scans, the SQL. */
export function ConvertReport({ r, tables }: { r: ConvertResult; tables: FormInfo["tables"] }) {
  const s = r.report?.summary;
  const cased = s?.caseSensitive ?? s?.case_sensitive ?? 0;
  const label = (key: string) => tables.find((t) => t.key === key)?.label ?? key;
  if (!r.report) return <p className="text-sm text-rose-600 dark:text-rose-400">{r.error || "Nothing to convert."}</p>;
  const parts = s ? [plural(s.terms, "word", "words"), plural(s.phrases, "phrase", "phrases"), s.near ? plural(s.near, "NEAR condition", "NEAR conditions") : "",
    s.wildcards ? `${fmtNum(s.wildcards)} with wildcards` : "", cased ? `${fmtNum(cased)} case-sensitive` : ""].filter(Boolean) : [];
  return (
    <div className="space-y-2.5 text-sm text-zinc-700 dark:text-zinc-300">
      {r.error && <p className="text-rose-600 dark:text-rose-400">{r.error}</p>}
      {s && <p>Converted by fixed rules from {ORIGIN[r.origin] ?? "the query"}: {parts.join(", ")}.</p>}
      {r.origin === "filters" && <pre className={pre}>{r.boolean}</pre>}
      {!!r.report.notes?.length && (
        <ul className="space-y-2">
          {r.report.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge tone={n.status === "converted" ? "emerald" : n.status === "approximated" ? "amber" : "rose"} className="shrink-0">
                {n.status}{n.effect && n.effect !== "nothing left" ? `: ${n.effect}` : ""}
              </Badge>
              <span className="min-w-0">
                {n.clause && <code className="break-all font-mono text-xs text-zinc-800 dark:text-zinc-200">{n.clause}</code>}
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">{n.note}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {r.report.warnings?.map((w) => <p key={w} className="text-xs text-amber-700 dark:text-amber-300">{w}</p>)}
      {r.estimate && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Searching would scan: {Object.entries(r.estimate).map(([k, e]) => (e.skip ? `${label(k)}: skipped (${e.skip})` : `${label(k)} ${gb(e.bytes ?? 0)}`)).join(" · ") || "no table"}
          {r.window ? ` (from ${fmtDateTime(r.window.from)}).` : "."}
        </p>
      )}
      {r.sql?.map((x) => (
        <details key={x.table}>
          <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-300">The SQL for {x.table}</summary>
          <pre className={cx(pre, "mt-1.5")}>{x.sql}</pre>
        </details>
      ))}
    </div>
  );
}

export function TempCheckForm({ info, past, canAct, enabled, brandwatch, caseId, initialIssue, onDone }: {
  info: FormInfo | undefined; past: PastCheck[]; canAct: boolean; enabled: boolean; brandwatch: boolean; caseId?: string; initialIssue?: string;
  onDone: (checkId: string) => void;
}) {
  const [mode, setModeState] = useState<"query" | "alert">(initialIssue || caseId ? "alert" : "query");
  // From a Brandwatch query
  const [qText, setQText] = useState("");
  const [qList, setQList] = useState<QueryRow[] | null>(null);
  const [qNote, setQNote] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  // No query yet
  const [aIssue, setAIssue] = useState(initialIssue ?? "");
  const [aText, setAText] = useState("");
  const [aAt, setAAt] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  // Count from
  const [from, setFrom] = useState<"auto" | "since">("auto");
  const [since, setSince] = useState("");
  // Our own data
  const [ownOn, setOwnOn] = useState(true);
  const [tables, setTables] = useState<string[] | null>(null);  // null: every table, until one is unticked
  const [ownq, setOwnq] = useState<"auto" | "typed" | "filters">(initialIssue || caseId ? "typed" : "auto");
  const [boolean, setBoolean] = useState("");
  const [f, setF] = useState({ all: "", any: "", none: "", authors: "", followers: "", platforms: [] as string[] });
  const [reuse, setReuse] = useState("");
  const [preview, setPreview] = useState<ConvertResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  // Gemini's lines, and the run
  const [writeup, setWriteup] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState("");
  const [runError, setRunError] = useState("");
  const [needs, setNeeds] = useState<Needs | null>(null);
  const started = useRef(0);

  const allTables = info?.tables ?? [];
  const ticked = tables ?? allTables.map((t) => t.key);
  const alert = mode === "alert";
  const ownShown = alert || ownOn;
  const locked = !canAct || running;

  const setMode = (next: "query" | "alert") => {
    setModeState(next);
    if (next === "alert" && ownq === "auto") setOwnq("typed");
    setRunError("");
    setNeeds(null);
    setDone("");
    setProgress(null);
  };

  // A conversion shown for one query says nothing about another: it goes when what would be searched changes
  useEffect(() => { setPreview(null); setPreviewError(""); }, [mode, ownq, picked?.ref]);

  // The search box: the event queries with every word typed, 250 ms after the last key; a link or id is looked up when run
  useEffect(() => {
    if (alert || !brandwatch) return;
    const text = qText.trim();
    if (looksLikeId(text)) {
      setQList(null);
      setQNote("A link or id: it is looked up when you run.");
      setPicked({ ref: text, name: text });
      return;
    }
    const t = window.setTimeout(() => {
      apiGet<{ queries: QueryRow[]; error: string }>("/temp-checks/queries", { q: text })
        .then((r) => { setQList(r.queries); setQNote(r.error || (r.queries.length ? "" : `No ${info?.event_query_prefix || "event"} query has those words.`)); })
        .catch((err: ApiError) => { setQList(null); setQNote(err.message); });
    }, 250);
    return () => window.clearTimeout(t);
  }, [qText, alert, brandwatch, info?.event_query_prefix]);

  const pick = (q: QueryRow) => {
    setPicked({ ref: String(q.id), name: q.name, id: q.id, created: q.created });
    setNeeds(null);
    setRunError("");
    apiGet<{ boolean: string }>(`/temp-checks/queries/${q.id}`)
      .then((full) => setPicked((p) => (p && p.id === q.id ? { ...p, boolean: full.boolean } : p)))
      .catch((err: ApiError) => setPicked((p) => (p && p.id === q.id ? { ...p, error: err.message } : p)));
  };

  const filtersNow = () => {
    const out = { all: f.all.trim(), any: f.any.trim(), none: f.none.trim(), authors: f.authors.trim(), min_followers: Number(f.followers) || 0, platforms: f.platforms };
    return out.all || out.any || out.none || out.authors || out.min_followers || out.platforms.length ? out : null;
  };
  const ownNow = () => ({ own_sources: ticked, reuse, boolean: ownq === "typed" ? boolean.trim() : "", filters: ownq === "filters" ? filtersNow() : null });
  const sinceNow = () => (from === "since" && since ? new Date(since).toISOString() : null);

  const showConversion = async () => {
    setPreviewing(true);
    setPreviewError("");
    try {
      const o = ownNow();
      setPreview(await apiSend<ConvertResult>("post", "/temp-checks/convert", {
        query: !alert && picked ? picked.ref : "", boolean: o.boolean, filters: o.filters, sources: o.own_sources, since: sinceNow(), estimate: true }));
    } catch (err) { setPreview(null); setPreviewError((err as ApiError).message); } finally { setPreviewing(false); }
  };

  const draft = async () => {
    setDrafting(true);
    setDraftNote("");
    try {
      const r = await apiSend<{ boolean: string; why: string }>("post", "/temp-checks/suggest", { text: [aIssue, aText].filter((x) => x.trim()).join("\n") });
      setOwnq("typed");
      setBoolean(r.boolean);
      setDraftNote(`Drafted: everything about it that also uses one of the words. Check it below before you run; to gather everything about it, keep only the first bracket. ${r.why}`);
    } catch (err) { setDraftNote((err as ApiError).message); } finally { setDrafting(false); }
  };

  const run = async () => {
    setRunError("");
    setNeeds(null);
    setDone("");
    let body: Record<string, unknown>;
    const o = ownNow();
    if (!alert) {
      if (!picked) { setRunError("Pick a Brandwatch query first."); return; }
      body = { query_ref: picked.ref, own_on: ownOn, ...o };
    } else {
      if (!aIssue.trim()) { setRunError("Name the issue the alert is about."); return; }
      body = { issue: aIssue.trim(), alert_text: aText.trim(), alert_at: (aAt ? new Date(aAt) : new Date()).toISOString(), from_alert: true,
        broad_draft: !(o.boolean || o.filters), ...o };
    }
    const key = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    started.current = Date.now();
    setRunning(true);
    setProgress(null);
    setElapsed(0);
    const poll = window.setInterval(() => {
      setElapsed(seconds(started.current, Date.now()));
      apiGet<Progress>(`/temp-checks/run/${key}`).then(setProgress).catch(() => undefined);
    }, 700);
    try {
      const res = await apiSend<RunResult>("post", "/temp-checks", { ...body, since: sinceNow(), writeup, run_key: key, case_id: caseId });
      if (res.needs) { setNeeds(res.needs); setProgress(null); return; }
      const check = res.check;
      if (!check) { setRunError(res.data?.user_error ?? "The temp check did not start."); return; }
      if (check.status === "failed") {
        setRunError(check.error || "It failed.");
        if (check.query?.choices?.length) setNeeds({ choices: check.query.choices.map((q) => ({ ...q, created: null, state: "" })), near: [], missing: 0 });
        return;
      }
      setDone(`Done in ${seconds(started.current, Date.now())} s.`);
      apiGet<Progress>(`/temp-checks/run/${key}`).then(setProgress).catch(() => undefined);  // every step, for a run quicker than the first look
      onDone(check.check_id);
    } catch (err) { setRunError((err as ApiError).message); } finally {
      window.clearInterval(poll);
      setRunning(false);
    }
  };

  const picks = needs ? [...needs.choices, ...needs.near] : [];
  const startMs = progress?.started_at ? new Date(progress.started_at).getTime() : started.current;
  return (
    <Card title="New temp check">
      <div className="space-y-4">
        <Segmented label="How to count" value={mode} onChange={setMode}
          options={[{ value: "query", label: "From a Brandwatch query" }, { value: "alert", label: "No query yet" }]} />

        {!alert && (
          <div className="space-y-2">
            <Field label="Brandwatch query" hint={`Search the ${info?.event_query_prefix || "event"} queries, or paste a link or id.`}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
                <Input className="pl-9" value={qText} onChange={(e) => setQText(e.target.value)} placeholder="e.g. gmail outage" autoComplete="off" disabled={locked || !brandwatch} />
              </div>
            </Field>
            {!brandwatch && <p className="text-xs text-amber-700 dark:text-amber-300">Brandwatch is not set up yet (Settings, Temp check). Use "No query yet" to count from our own tables.</p>}
            {qNote && <p className="text-xs text-zinc-500 dark:text-zinc-400">{qNote}</p>}
            {!!qList?.length && (
              <ul className="scroll-thin max-h-56 divide-y divide-zinc-100 overflow-y-auto rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {qList.map((q) => (
                  <li key={q.id}>
                    <button type="button" disabled={locked} onClick={() => pick(q)} aria-pressed={picked?.id === q.id}
                      className={cx("block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-zinc-800/50",
                        picked?.id === q.id && "bg-blue-50 dark:bg-blue-500/10")}>
                      <span className="block text-zinc-900 dark:text-zinc-100">{q.name}</span>
                      <span className="text-xs text-zinc-500">made {fmtDateTime(q.created)}{q.state && q.state !== "active" ? ` · ${q.state}: Brandwatch gives no numbers for it` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {picked?.id && (
              <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-sm dark:border-blue-500/30 dark:bg-blue-500/5">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">{picked.name}</p>
                <p className="text-xs text-zinc-500">id {picked.id} · made {fmtDateTime(picked.created)}</p>
                {picked.error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{picked.error}</p>}
                {picked.boolean !== undefined && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-300">Its Boolean ({fmtNum(picked.boolean.length)} characters)</summary>
                    <pre className={cx(pre, "mt-1.5")}>{picked.boolean}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        {alert && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              For the moment an alert fires, before anyone has built the Brandwatch query. Brandwatch is still asked, through its standing Google queries,
              and every table of ours is searched with the same query. The write-up says where its numbers come from.
            </p>
            <Field label="Issue name"><Input value={aIssue} onChange={(e) => setAIssue(e.target.value)} placeholder="e.g. Alleged Gmail Outage" disabled={locked} /></Field>
            <Field label="The alert post" hint="Optional: its words, for drafting a query."><Textarea rows={3} value={aText} onChange={(e) => setAText(e.target.value)} disabled={locked} /></Field>
            <Field label="When the alert fired" hint="Your computer's time. Blank means now."><Input type="datetime-local" value={aAt} onChange={(e) => setAAt(e.target.value)} disabled={locked} /></Field>
            <div>
              <Button icon={<Sparkles className="size-4" />} loading={drafting} disabled={locked || !(aIssue.trim() || aText.trim())} onClick={draft}>Draft a broad query (Gemini)</Button>
              {draftNote && <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{draftNote}</p>}
            </div>
          </div>
        )}

        <Group legend="Count from">
          <Radio name="tc-from" checked={from === "auto"} onChange={() => setFrom("auto")} disabled={locked}>
            {alert ? `The ${info?.no_query_hours ?? 24} hours before the alert` : `The issue's start (the first hour with ${fmtNum(info?.spike_mentions ?? 100)}+ mentions)`}
          </Radio>
          <Radio name="tc-from" checked={from === "since"} onChange={() => setFrom("since")} disabled={locked}>A time I choose</Radio>
          {from === "since" && (
            <Field label="Count from" hint={`Your computer's time. Up to ${info?.since_max_days ?? 31} days back.`}>
              <Input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} disabled={locked} />
            </Field>
          )}
        </Group>

        <Group legend="Our own data">
          {!alert && <Toggle checked={ownOn} onChange={setOwnOn} disabled={locked} label="Also search our own tables, next to Brandwatch's numbers" />}
          {ownShown && (
            <>
              {allTables.length ? (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {allTables.map((t) => (
                    <span key={t.key} title={t.what || t.freshness || undefined}>
                      <Toggle checked={ticked.includes(t.key)} disabled={locked} label={t.label}
                        onChange={(on) => setTables(on ? [...ticked, t.key] : ticked.filter((k) => k !== t.key))} />
                    </span>
                  ))}
                </div>
              ) : <p className="text-xs text-amber-700 dark:text-amber-300">No table of posts is set up yet (Settings, Temp check).</p>}
              <div className="space-y-2">
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Search them with</p>
                {!alert && <Radio name="tc-ownq" checked={ownq === "auto"} onChange={() => setOwnq("auto")} disabled={locked}>The Brandwatch query's own Boolean, converted</Radio>}
                <Radio name="tc-ownq" checked={ownq === "typed"} onChange={() => setOwnq("typed")} disabled={locked}>A Boolean query I type or paste</Radio>
                <Radio name="tc-ownq" checked={ownq === "filters"} onChange={() => setOwnq("filters")} disabled={locked}>Filters</Radio>
              </div>
              {ownq === "typed" && (
                <Textarea rows={5} aria-label="Boolean query" value={boolean} onChange={(e) => setBoolean(e.target.value)} disabled={locked}
                  placeholder={'(gmail OR "google mail") NEAR/10 (down OR outage*) NOT giveaway'} className="font-mono text-xs" />
              )}
              {ownq === "filters" && (
                <div className="space-y-3">
                  <Field label="All of these" hint="Words or phrases, comma separated."><Input value={f.all} onChange={(e) => setF({ ...f, all: e.target.value })} disabled={locked} /></Field>
                  <Field label="Any of these"><Input value={f.any} onChange={(e) => setF({ ...f, any: e.target.value })} disabled={locked} /></Field>
                  <Field label="None of these"><Input value={f.none} onChange={(e) => setF({ ...f, none: e.target.value })} disabled={locked} /></Field>
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">On</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {(info?.platforms ?? []).map((p) => (
                        <Toggle key={p} checked={f.platforms.includes(p)} disabled={locked} label={p}
                          onChange={(on) => setF({ ...f, platforms: on ? [...f.platforms, p] : f.platforms.filter((x) => x !== p) })} />
                      ))}
                    </div>
                  </div>
                  <Field label="By these accounts"><Input value={f.authors} onChange={(e) => setF({ ...f, authors: e.target.value })} placeholder="@handle, @handle" disabled={locked} /></Field>
                  <Field label="With at least this many followers"><Input type="number" min={0} step={100} value={f.followers} onChange={(e) => setF({ ...f, followers: e.target.value })} disabled={locked} /></Field>
                </div>
              )}
              <Field label="Reuse posts gathered earlier" hint="Searches only the time since.">
                <Select value={reuse} onChange={(e) => setReuse(e.target.value)} disabled={locked}>
                  <option value="">No: search afresh</option>
                  {past.filter((c) => c.own_posts > 0).map((c) => (
                    <option key={c.check_id} value={c.check_id}>{c.issue} · {fmtNum(c.own_posts)} posts from {fmtDateTime(c.own_from)}, gathered {fmtDateTime(c.created_at)}</option>
                  ))}
                </Select>
              </Field>
              <div>
                <Button loading={previewing} onClick={showConversion}>Show how the query converts</Button>
                {previewError && <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{previewError}</p>}
                {preview && <div className="mt-2.5"><ConvertReport r={preview} tables={allTables} /></div>}
              </div>
            </>
          )}
        </Group>

        <Toggle checked={writeup} onChange={setWriteup} disabled={locked} label="Have Gemini write the summary, negativity drivers and themes" />

        <Button variant="primary" icon={<Thermometer className="size-4" />} disabled={!canAct || !enabled} loading={running} onClick={run}>Run temp check</Button>

        <div aria-live="polite" className="space-y-1.5 empty:hidden">
          {running && !progress?.steps.length && <p className="text-sm text-blue-600 dark:text-blue-300">Starting…</p>}
          {(running || done) && !!progress?.steps.length && (
            <ol className="space-y-1 text-sm">
              {progress.steps.map((s, i) => (
                <li key={i} className={cx("flex gap-2", running && i === progress.steps.length - 1 ? "text-blue-600 dark:text-blue-300" : "text-zinc-600 dark:text-zinc-400")}>
                  <span className="w-9 shrink-0 text-right tabular-nums text-zinc-400">{seconds(startMs, new Date(s.at).getTime())} s</span>
                  <span className="min-w-0">{s.text}</span>
                </li>
              ))}
            </ol>
          )}
          {running && <p className="text-xs text-zinc-400">{elapsed} s so far</p>}
          {done && <p className="text-sm text-emerald-700 dark:text-emerald-300">{done}</p>}
          {runError && <p className="text-sm text-rose-600 dark:text-rose-400">{runError}</p>}
          {needs && (
            <div className="space-y-1.5">
              <p className="text-sm text-rose-600 dark:text-rose-400">
                {needs.missing ? `Brandwatch has no query ${needs.missing} in this project.` : picks.length ? "More than one query fits, or none exactly. Pick one:" : "No Brandwatch query matches that."}
              </p>
              {picks.map((q) => (
                <button key={q.id} type="button" onClick={() => { setModeState("query"); pick(q); }}
                  className="block text-left text-sm text-blue-600 hover:underline dark:text-blue-300">{q.name}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
