import { ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { useApi } from "../api/hooks";
import { Badge, Card, cx, EmptyState, ErrorState, PageHeader, Segmented, Spinner, Stat, TD, TH, TR } from "../components/ui";
import { GRADE, STEP_TONE, STEP_WORD, type QaEval } from "../components/workspace/types";
import { fmtDate, fmtDateTime } from "../lib/format";

interface CriterionRow { subject_type: "case" | "agent_alert"; id: string; label: string; rated: number; mean: number | null; low: number }
interface Report {
  days: number; evals: QaEval[]; pass_at: number; fail_below: number;
  /** The switch "Apply evaluation lessons without approval": a lesson nothing goes against is put to use with no lead. */
  lessons_auto_apply: boolean;
  summary: {
    count: number; mean_score: number | null; pass_rate: number | null; grades: Record<"pass" | "needs_work" | "fail", number>; evaluators: number; read_by_gemini: number; revised: number;
    lessons: { filed: number; waiting: number; held: number; applied: number; rejected: number; failed: number }; examples_kept: number; verdicts_recorded: number;
  };
  criteria: CriterionRow[];
  weekly: { week: string; count: number; mean_score: number | null }[];
}

type Kind = "" | "case" | "agent_alert";
const KIND_WORDS: Record<string, string> = { case: "Review of an alert", agent_alert: "An alert it raised" };

/** A rating's mean as a bar on the 1 to 5 scale. The number beside it is the one the server counted. */
function MeanBar({ mean }: { mean: number | null }) {
  if (mean === null) return <span className="text-xs text-zinc-400">not rated yet</span>;
  const tone = mean >= 4 ? "bg-emerald-500" : mean >= 3 ? "bg-violet-500" : "bg-rose-500";
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"><span className={cx("block h-full rounded-full", tone)} style={{ width: `${((mean - 1) / 4) * 100}%` }} /></span>
      <span className="tabular-nums text-zinc-800 dark:text-zinc-200">{mean.toFixed(1)}</span><span className="text-xs text-zinc-400">of 5</span>
    </span>
  );
}

function EvalRow({ ev, open, onToggle }: { ev: QaEval; open: boolean; onToggle: () => void }) {
  const grade = GRADE[ev.grade] ?? GRADE[""];
  const lessons = ev.steps.filter((s) => s.kind === "lesson");
  return (
    <>
      <tr className={cx(TR, "cursor-pointer")} onClick={onToggle} aria-expanded={open}>
        <td className={cx(TD, "whitespace-nowrap")}>{fmtDateTime(ev.at)}</td>
        <td className={TD}>
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{ev.title}</span>
          <span className="block text-xs text-zinc-500">{ev.id}{ev.revision > 0 ? " (revised)" : ""} · {KIND_WORDS[ev.subject_type]}{ev.case_id ? <> · <Link className="text-blue-600 dark:text-blue-200" to={`/feed/${ev.case_id}`} onClick={(e) => e.stopPropagation()}>{ev.case_id}</Link></> : null}</span>
        </td>
        <td className={TD}>{ev.evaluator}</td>
        <td className={cx(TD, "whitespace-nowrap tabular-nums")}><span className="font-medium">{ev.score ?? "n/a"}</span> <Badge tone={grade.tone}>{grade.label}</Badge></td>
        <td className={TD}>{ev.comprehension.by === "gemini" ? "Gemini" : "Plain reading"}</td>
        <td className={TD}>{lessons.length ? `${lessons.filter((s) => s.status === "applied").length} of ${lessons.length} in use` : "none"}</td>
      </tr>
      {open && (
        <tr className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-950/40">
          <td colSpan={6} className="px-5 py-4">
            <div className="grid gap-5 lg:grid-cols-3">
              <div>
                <p className="mb-1.5 text-xs font-medium text-zinc-500">The analyst's ratings ({ev.rated} of {ev.of})</p>
                <ul className="space-y-1 text-sm">{Object.entries(ev.ratings).map(([k, v]) => <li key={k} className="flex justify-between gap-3"><span className="text-zinc-600 dark:text-zinc-400">{k.replace(/_/g, " ")}</span><span className="tabular-nums">{v ?? "not rated"}</span></li>)}</ul>
                {ev.corrections.verdict && <p className="mt-2 text-xs text-zinc-500">Its call should have been: {ev.corrections.verdict.replace(/_/g, " ").toLowerCase()}</p>}
                {ev.comment && <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">“{ev.comment}”</p>}
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-zinc-500">How it was understood</p>
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{ev.comprehension.understood}</p>
                {ev.comprehension.why_plain && <p className="mt-2 text-xs text-zinc-500">Gemini's reading was not used: {ev.comprehension.why_plain}</p>}
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-zinc-500">What was done with it</p>
                <ul className="space-y-2">
                  {ev.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <Badge tone={STEP_TONE[s.status]} className="mt-0.5 shrink-0">{STEP_WORD[s.status]}</Badge>
                      <span className="min-w-0 text-zinc-800 dark:text-zinc-200">{s.kind === "lesson" ? <><span className="text-zinc-500">Lesson: </span>{s.text}</> : s.text}
                        {s.note && <span className="block text-xs text-zinc-500">{s.note}{s.decided_by ? ` (${s.decided_by})` : ""}</span>}</span>
                    </li>
                  ))}
                  {ev.steps.length === 0 && <li className="text-sm text-zinc-500">Nothing.</li>}
                </ul>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Every QA evaluation of the chatbot's work: its score, how the feedback was understood, and what was done with it. */
export default function QaEvalsPage() {
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState<Kind>("");
  const [open, setOpen] = useState("");
  const report = useApi<Report>("/qa-evals", { days, subject_type: kind }, 120_000);
  const r = report.data;
  const s = r?.summary;
  return (
    <div>
      <PageHeader title="Chatbot QA evaluations"
        description="How analysts graded the chatbot's work, and what became of each grade. Every score and average here is counted from the ratings; no model sets one."
        actions={<>
          <Segmented label="What was graded" value={kind} onChange={setKind} options={[{ value: "", label: "Everything" }, { value: "case", label: "Reviews of alerts" }, { value: "agent_alert", label: "Its own alerts" }]} />
          <Segmented label="Days" value={days} onChange={setDays} options={[7, 30, 90].map((n) => ({ value: n, label: `${n} days` }))} />
        </>} />
      <ErrorState error={report.error} onRetry={report.reload} />
      {report.loading && !r ? <Spinner /> : r && s && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Evaluations" value={s.count} hint={`one an alert, by ${s.evaluators} ${s.evaluators === 1 ? "person" : "people"}; ${s.revised} revised`} />
            <Stat label="Average score" value={s.mean_score ?? "n/a"} hint="of 100" tone={s.mean_score === null ? undefined : s.mean_score >= r.pass_at ? "emerald" : s.mean_score < r.fail_below ? "rose" : "violet"} />
            <Stat label="Passed" value={s.pass_rate === null ? "n/a" : `${Math.round(s.pass_rate * 100)}%`} hint={`${s.grades.pass} pass, ${s.grades.needs_work} need work, ${s.grades.fail} fail`} />
            <Stat label="Lessons filed" value={s.lessons.filed} hint={`${s.lessons.applied} in use, ${s.lessons.held + s.lessons.waiting} with a lead`} />
            <Stat label="Checked examples kept" value={s.examples_kept} hint="the agent is tested against these" />
            <Stat label="Read by Gemini" value={s.read_by_gemini} hint={`of ${s.count}; the rest read plainly`} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
            <Card padded={false} title="Where the chatbot does well and badly" subtitle="The average rating on each thing analysts grade, 1 (wrong) to 5 (right).">
              <table className="w-full">
                <thead><tr><th className={TH}>Graded</th><th className={TH}>What</th><th className={TH}>Average</th><th className={TH}>Rated</th><th className={TH}>Rated 1 or 2</th></tr></thead>
                <tbody>
                  {r.criteria.filter((c) => !kind || c.subject_type === kind).map((c) => (
                    <tr key={`${c.subject_type}-${c.id}`} className={TR}>
                      <td className={cx(TD, "text-xs text-zinc-500")}>{KIND_WORDS[c.subject_type]}</td><td className={TD}>{c.label}</td>
                      <td className={TD}><MeanBar mean={c.mean} /></td><td className={cx(TD, "tabular-nums")}>{c.rated}</td><td className={cx(TD, "tabular-nums")}>{c.low}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Week by week" subtitle="The average score of the evaluations submitted each week.">
              {r.weekly.length === 0 ? <p className="text-sm text-zinc-500">No evaluations in this period.</p> : (
                <ul className="space-y-2">
                  {r.weekly.map((w) => (
                    <li key={w.week} className="grid grid-cols-[6.5rem_1fr_5.5rem] items-center gap-3 text-sm">
                      <span className="text-xs text-zinc-500">Week of {fmtDate(w.week)}</span>
                      <span className="h-2.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"><span className="bg-spark block h-full rounded-full" style={{ width: `${w.mean_score ?? 0}%` }} /></span>
                      <span className="text-right tabular-nums">{w.mean_score ?? "n/a"} <span className="text-xs text-zinc-400">({w.count})</span></span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-4 text-xs text-zinc-500">
                {r.lessons_auto_apply
                  ? "Gemini compares a lesson with the lessons already in use and the nearest passages of the knowledge documents. Nothing against it: it is in use at once. Something against it, or no clear answer: it is held for a lead under "
                  : "A lesson is used by the agent only after a lead approves it under "}
                <Link className="font-medium text-blue-600 dark:text-blue-200" to="/learning">Knowledge, Learning</Link>. {s.lessons.held + s.lessons.waiting} with a lead now.
                {" "}A lesson in use is read by the alert reviewer on every alert, or by the agent's own alert review when it came from one of its alerts.
              </p>
            </Card>
          </div>

          <Card padded={false} title="Evaluations" subtitle="Open one to see the ratings, how the feedback was understood, and each step taken to apply it.">
            {r.evals.length === 0 ? (
              <EmptyState icon={<ClipboardCheck className="size-8" />} title="No evaluations yet">Open an alert in the <Link className="font-medium text-blue-600 dark:text-blue-200" to="/feed">Review feed</Link> and press Grade the chatbot's work.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead><tr><th className={TH}>When</th><th className={TH}>Alert</th><th className={TH}>Graded by</th><th className={TH}>Score</th><th className={TH}>Understood by</th><th className={TH}>Lessons</th></tr></thead>
                  <tbody>{r.evals.map((ev) => <EvalRow key={ev.id} ev={ev} open={open === ev.id} onToggle={() => setOpen(open === ev.id ? "" : ev.id)} />)}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
