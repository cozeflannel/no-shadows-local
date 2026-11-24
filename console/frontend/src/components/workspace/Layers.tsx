import { ExternalLink, Send, Sparkles, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import { apiSend, type ApiError } from "../../api/client";
import { useApi } from "../../api/hooks";
import { useApp } from "../../context";
import { fmtDateTime } from "../../lib/format";
import { humanize, verdictLabel } from "../../lib/labels";
import { TempCheckForm, type FormInfo } from "../TempCheckForm";
import type { TcCheck } from "../TempCheckResult";
import { Alert, Badge, Button, cx, ErrorState, Field, Input, OffNotice, Select, Spinner, Textarea } from "../ui";
import { GRADE, STEP_TONE, STEP_WORD, type QaEval, type QaStanding, type Rubric } from "./types";

const TempCheckResult = lazy(() => import("../TempCheckResult").then((m) => ({ default: m.TempCheckResult })));

/**
 * What opens over the alert: a temp check, or the evaluation form. One at a time; the alert stays behind it, and Escape or
 * the X brings it back.
 */
export function Layer({ title, subtitle, onClose, actions, children, wide = true }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; actions?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/55 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        className={cx("glow flex max-h-[92vh] w-full flex-col rounded-2xl border border-transparent bg-zinc-50 shadow-2xl dark:bg-zinc-950", wide ? "max-w-6xl" : "max-w-3xl")}>
        <header className="flex flex-wrap items-start gap-3 rounded-t-2xl border-b border-zinc-200 bg-white px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-zinc-950 dark:text-zinc-50">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}
            <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-5" /></button>
          </div>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// -- temp checks ------------------------------------------------------------------------------------------------------------
interface CheckBrief { check_id: string; issue: string; status: string; total: number; concern_level: string; basis: string; requested_by: string; case_id: string | null; created_at: string; title: string; error: string; own_posts: number; own_from: string | null; actions: { actor: string; action: string; at: string; note: string }[] }
type Check = CheckBrief & TcCheck & { doc_url: string; notes: string[]; steps: { at: string; text: string }[] };
interface CheckList { checks: CheckBrief[]; enabled: boolean; web_enabled: boolean; setup: { brandwatch: boolean }; form: FormInfo }

const CHECK_STATUS: Record<string, { label: string; tone: "emerald" | "rose" | "violet" | "blue" | "zinc" }> = {
  complete: { label: "Done", tone: "emerald" }, failed: { label: "Failed", tone: "rose" }, query_not_confirmed: { label: "Query needs work", tone: "violet" },
  running: { label: "Running", tone: "blue" }, empty: { label: "Nothing matched", tone: "zinc" },
};
export const checkStatus = (s: string) => CHECK_STATUS[s] ?? { label: humanize(s), tone: "zinc" as const };

/** A temp check as a preview over the alert: confirm it, send it to Chat, open its document, or have Gemini reword it. */
export function TempCheckLayer({ id, canAct, onClose, onChanged, onOpen }: { id: string; canAct: boolean; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const { toast } = useApp();
  const { data, error, loading, reload, setData } = useApi<{ check: Check }>(`/temp-checks/${id}`);
  const info = useApi<CheckList>("/temp-checks", { limit: 1 });
  const [busy, setBusy] = useState("");
  const [ask, setAsk] = useState("");
  useEffect(() => {
    if (data?.check.status !== "running") return;
    const t = window.setInterval(reload, 4000);
    return () => window.clearInterval(t);
  }, [data?.check.status, reload]);
  const c = data?.check;
  const run = async (key: string, fn: () => Promise<{ check?: Check }>, done: string, then?: () => void) => {
    setBusy(key);
    try {
      const res = await fn();
      if (res.check && data) setData({ ...data, check: res.check });
      toast(done); onChanged(); then?.();
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const act = (action: string) => run(action, () => apiSend<{ check: Check }>("post", `/temp-checks/${id}/action`, { action }), "Recorded");
  const confirm = () => run("used", () => apiSend<{ check: Check }>("post", `/temp-checks/${id}/action`, { action: "used" }), "Temp check confirmed", onClose);
  const send = () => run("share", () => apiSend<{ check: Check }>("post", `/temp-checks/${id}/share`, {}), "Queued for the analysts' space", onClose);
  const revise = () => run("revise", async () => {
    const res = await apiSend<{ changed: boolean; check: Check }>("post", `/temp-checks/${id}/revise`, { instruction: ask });
    if (res.changed) setAsk("");
    return res;
  }, "Reworded");
  const refresh = async () => {
    if (!c) return;
    setBusy("refresh");
    try {
      const res = await apiSend<{ check_id?: string; check?: { check_id: string } }>("post", "/temp-checks", { issue: c.issue, update_of: c.check_id, case_id: c.case_id });
      const next = res.check?.check_id ?? res.check_id;
      if (next) { onChanged(); onOpen(next); }
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const counted = c?.status === "complete" || c?.status === "empty";
  return (
    <Layer onClose={onClose} title={c ? c.issue || c.title : "Temp check"}
      subtitle={c && <span className="flex flex-wrap items-center gap-2"><Badge tone={checkStatus(c.status).tone}>{checkStatus(c.status).label}</Badge>{c.check_id}<span>by {c.requested_by}</span>{c.concern_level && <Badge tone="zinc">{c.concern_level}</Badge>}</span>}
      actions={c && <>
        {c.doc_url && <a href={c.doc_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800" title="Open the Google Doc to edit it there">Edit in Google Docs<ExternalLink className="size-3.5" /></a>}
        <Button disabled={!canAct || c.status !== "complete"} loading={busy === "share"} icon={<Send className="size-4" />} onClick={send}
          title="Confirm it and queue a message for the analysts' space with its summary and the link to its document">Confirm and send to Chat</Button>
        <Button variant="primary" disabled={!canAct || c.status !== "complete"} loading={busy === "used"} onClick={confirm}>Confirm and close</Button>
      </>}>
      {loading && !data ? <Spinner /> : <ErrorState error={error} onRetry={reload} />}
      {c && (
        <div className="space-y-4">
          {c.status === "failed" && <Alert tone="rose" title="This temp check failed">{c.error}</Alert>}
          {c.status === "running" && (c.steps.length
            ? <ol className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">{c.steps.map((st, i) => <li key={i} className={i === c.steps.length - 1 ? "text-blue-600 dark:text-blue-300" : ""}>{st.text}</li>)}</ol>
            : <Spinner label="Starting…" />)}
          {!counted && c.status !== "running" && c.notes.map((n) => <Alert key={n} tone="blue">{n}</Alert>)}
          {c.status === "complete" && canAct && (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100"><Sparkles className="size-4 text-violet-500" />Ask Gemini to change the write-up</p>
              <div className="flex flex-wrap gap-2">
                <Input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="For example: lead with the negativity drivers, and make the summary shorter" className="min-w-64 flex-1"
                  aria-label="What to change" onKeyDown={(e) => { if (e.key === "Enter" && ask.trim()) void revise(); }} />
                <Button loading={busy === "revise"} disabled={!ask.trim()} onClick={revise}>Reword</Button>
              </div>
              <p className="mt-2 text-xs text-zinc-500">Gemini rewords the summary, the negativity drivers and the themes. The counts stay the ones that were counted: a rewrite that brings a new figure is refused.{c.doc_url ? " A reworded write-up gets a new document." : ""}</p>
            </div>
          )}
          {counted && <Suspense fallback={<Spinner />}>
            <TempCheckResult c={c} tables={info.data?.form.tables ?? []} canAct={canAct} web={!!info.data?.web_enabled} busy={busy} onRefresh={refresh} onKeep={act} toast={toast} />
          </Suspense>}
          {c.actions.length > 0 && (
            <ul className="space-y-1 text-xs text-zinc-500">{c.actions.map((a, i) => <li key={i}>{fmtDateTime(a.at)}: {humanize(a.action)} by {a.actor}{a.note ? ` (${a.note})` : ""}</li>)}</ul>
          )}
        </div>
      )}
    </Layer>
  );
}

/** Start a temp check for this alert without leaving it. */
export function TempCheckNewLayer({ caseId, issue, canAct, onClose, onDone }: { caseId?: string; issue: string; canAct: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const list = useApi<CheckList>("/temp-checks", { limit: 30 });
  return (
    <Layer wide={false} onClose={onClose} title="Run a temp check" subtitle="How big the conversation about this alert's issue is, right now.">
      {list.loading && !list.data ? <Spinner /> : <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && !list.data.enabled && <OffNotice what="Temp check" flag="temp_checks" />}
      {list.data && <TempCheckForm info={list.data.form} past={list.data.checks} canAct={canAct} enabled={list.data.enabled} brandwatch={list.data.setup.brandwatch}
        caseId={caseId} initialIssue={issue} onDone={onDone} />}
    </Layer>
  );
}

// -- the QA evaluation ---------------------------------------------------------------------------------------------------------
function Result({ ev }: { ev: QaEval }) {
  const grade = GRADE[ev.grade] ?? GRADE[""];
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-2xl font-medium tabular-nums text-zinc-950 dark:text-zinc-50">{ev.score ?? "n/a"}</span><span className="text-zinc-500">of 100</span>
        <Badge tone={grade.tone}>{grade.label}</Badge>
        <span className="ml-auto text-xs text-zinc-500">{ev.id} · {ev.evaluator} · {fmtDateTime(ev.at)} · {ev.rated} of {ev.of} rated{ev.revision > 0 ? ` · revised ${ev.revision === 1 ? "once" : `${ev.revision} times`}` : ""}</span>
      </p>
      {ev.comment && <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">“{ev.comment}”</p>}
      <p className="mt-3 text-xs font-medium text-zinc-500">What {ev.comprehension.by === "gemini" ? "Gemini" : "the agent"} understood</p>
      <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">{ev.comprehension.understood}</p>
      <p className="mt-3 text-xs font-medium text-zinc-500">What was done with it</p>
      <ul className="mt-1 space-y-1.5">
        {ev.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <Badge tone={STEP_TONE[s.status]} className="mt-0.5 shrink-0">{STEP_WORD[s.status]}</Badge>
            <span className="min-w-0 text-zinc-800 dark:text-zinc-200">{s.kind === "lesson" ? <><span className="text-zinc-500">Lesson: </span>{s.text}</> : s.text}{s.note ? <span className="block text-xs text-zinc-500">{s.note}</span> : null}</span>
          </li>
        ))}
        {ev.steps.length === 0 && <li className="text-sm text-zinc-500">Nothing yet.</li>}
      </ul>
    </div>
  );
}

/**
 * The analyst grades the chatbot's work on one alert. The score is counted by the server from the ratings and their
 * weights; Gemini only says back what it understood. One person evaluates an alert: the first to submit, who can revise
 * it here; everyone else reads it. What becomes of each lesson (in use, held for a lead, waiting) is said under the result.
 */
export function EvalLayer({ subjectType, subjectId, title, rubric, evals, standing, verdicts, canAct, onClose, onSubmitted }: {
  subjectType: "case" | "agent_alert"; subjectId: string; title: string; rubric: Rubric; evals: QaEval[]; standing: QaStanding; verdicts: string[]; canAct: boolean;
  onClose: () => void; onSubmitted: (ev?: QaEval) => void;  // called with nothing when someone else turned out to have evaluated it first
}) {
  const { toast } = useApp();
  const mine = standing.mine ? evals.find((e) => e.id === standing.eval_id) : undefined;  // the evaluation this person may revise
  const theirs = !!standing.evaluator && !standing.mine;
  const [ratings, setRatings] = useState<Record<string, number | null>>(() => ({ ...(mine?.ratings ?? {}) }));
  const [comment, setComment] = useState(mine?.comment ?? "");
  const [verdict, setVerdict] = useState(mine?.corrections?.verdict ?? "");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<QaEval | null>(null);
  const rated = rubric.criteria.filter((c) => ratings[c.id] != null).length;
  const submit = async () => {
    setBusy(true);
    try {
      const res = await apiSend<{ eval: QaEval }>("post", "/qa-evals", { subject_type: subjectType, subject_id: subjectId, ratings, comment, verdict: verdict || undefined });
      setMade(res.eval); onSubmitted(res.eval); toast(mine ? "Evaluation revised" : "Evaluation submitted");
    } catch (err) {
      toast((err as ApiError).message, "error");
      if ((err as ApiError).status === 409) onSubmitted();  // someone else evaluated it meanwhile: show theirs
    } finally { setBusy(false); }
  };
  if (theirs) {
    return (
      <Layer wide={false} onClose={onClose} title="The evaluation of this alert" subtitle={title}>
        <div className="space-y-4">
          <Alert tone="blue" title={`Evaluated by ${standing.evaluator}`}>One person evaluates an alert, and only they can revise it.</Alert>
          {evals.map((ev, i) => (
            <div key={ev.id} className="space-y-2">
              {i === 1 && <p className="text-xs font-medium text-zinc-500">Kept from before one person evaluated an alert</p>}
              <Result ev={ev} />
            </div>
          ))}
        </div>
      </Layer>
    );
  }
  return (
    <Layer wide={false} onClose={onClose} title={made ? "Your evaluation" : mine ? "Revise your evaluation" : subjectType === "case" ? "Grade the chatbot's review" : "Grade the chatbot's alert"} subtitle={title}
      actions={!made && <Button variant="primary" disabled={!canAct || rated === 0} loading={busy} onClick={submit}>{mine ? "Save the revision" : "Submit evaluation"}</Button>}>
      {made ? (
        <div className="space-y-4">
          <Alert tone="emerald" title={made.revision > 0 ? "Revised" : "Submitted"}>The score was counted from your ratings. Here is what was understood and what was done with it.</Alert>
          <Result ev={made} />
          <Button onClick={onClose}>Back to the alert</Button>
        </div>
      ) : (
        <div className="space-y-5">
          {!canAct && <Alert tone="blue">Only analysts and Incident Managers can submit an evaluation.</Alert>}
          {mine ? <Alert tone="blue" title="This is your evaluation">Change what you rated or wrote and save. It stays one evaluation: the score is counted again, and a lesson your revision no longer teaches is withdrawn.</Alert>
            : canAct && <p className="text-xs text-zinc-500">One person evaluates an alert. Once you submit, this evaluation is yours: you can revise it, and nobody else can submit one.</p>}
          <ul className="space-y-4">
            {rubric.criteria.map((c) => (
              <li key={c.id} className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.label}</p>
                <p className="mt-0.5 text-xs text-zinc-500">{c.asks}</p>
                <div role="radiogroup" aria-label={c.label} className="mt-3 flex flex-wrap gap-1.5">
                  {rubric.scale.map((s) => (
                    <button key={s.value} type="button" role="radio" aria-checked={ratings[c.id] === s.value} disabled={!canAct}
                      onClick={() => setRatings((r) => ({ ...r, [c.id]: s.value }))}
                      className={cx("rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                        ratings[c.id] === s.value ? "border-blue-600 bg-blue-600 text-white dark:border-blue-200 dark:bg-blue-200 dark:text-blue-900"
                          : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800")}>
                      {s.value} · {s.label}
                    </button>
                  ))}
                  <button type="button" role="radio" aria-checked={ratings[c.id] == null} disabled={!canAct} onClick={() => setRatings((r) => ({ ...r, [c.id]: null }))}
                    className={cx("rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                      ratings[c.id] == null ? "border-zinc-500 bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100" : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800")}>
                    Not rated
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {subjectType === "case" && (
            <Field label="What its call should have been (only if it was wrong)">
              <Select value={verdict} onChange={(e) => setVerdict(e.target.value)} disabled={!canAct}>
                <option value="">It was right, or I can't say</option>{verdicts.map((v) => <option key={v} value={v}>{verdictLabel(v)}</option>)}
              </Select>
            </Field>
          )}
          <Field label="What was right, what was wrong, and what it should do next time" hint="This is what the agent learns from. Say it plainly.">
            <Textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} disabled={!canAct} className="font-sans text-sm" />
          </Field>
          <p className="text-xs text-zinc-500">{rated} of {rubric.criteria.length} rated. The score is counted from your ratings and their weights ({rubric.pass_at} and above passes); no model sets or changes it.</p>
          {evals.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-medium text-zinc-500">{mine ? "Your evaluation as it stands" : "Evaluations of this alert"}</p>
              {evals.map((ev) => <Result key={ev.id} ev={ev} />)}
            </div>
          )}
        </div>
      )}
    </Layer>
  );
}
