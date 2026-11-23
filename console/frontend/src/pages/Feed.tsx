import { ArrowLeft, ExternalLink, Inbox, Plus, Search, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import type { ActionDef } from "../api/types";
import { Alert, Badge, Button, Card, CaseBadges, cx, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Segmented, Select, Spinner, Textarea } from "../components/ui";
import { useApp } from "../context";
import { fmtDateTime, fmtMinutes, fmtRelative, fmtValue, probability } from "../lib/format";
import { humanize, plainReason, suppressionLabel, TARGET_LABEL, verdictLabel } from "../lib/labels";
import { useLive } from "../lib/live";

type View = "action" | "review" | "verified" | "suppressed" | "closed" | "all";
interface Correction { field: string; old: unknown; new: unknown; reason: string; confidence: number | null; applied: boolean; reverted_by: string | null }
interface Burson { filled: number; right: number; wrong: string[]; in_question: string[]; pct: number | null }
interface Kept { kept: number; of: number; rate: number }
interface FeedCard {
  case_id: string; status: string; alert_name: string | null; issue_name: string | null; product: string | null; exposure_tag: string | null;
  priority: string | null; platform: string | null; verdict: string | null; review_probability: number | null; burson: Burson | null; needs: string; waiting_min: number;
  classification: { label: string; probability?: unknown; rationale: string; trusted: boolean; decided_by: string } | null;  // probability: older cases may lack it
  field_agreement: { days: number; assessments: number; fields: Record<string, Kept> };
  citations: { ref: string; title: string; link: string; kind: string; excerpt: string }[];
  proposed_actions: { code: string; label: string; kind: string }[];
  actions_taken: { code: string; actor: string; at: string; note: string | null; escalation_id: string | null }[];
  applied_corrections: Correction[]; proposed_corrections: Correction[];
  review_reasons: string[]; post_url: string | null; author: string | null; latest_received_at: string; acknowledged_at: string | null;
  review_reasons_plain?: string[]; suppression_label?: string | null;  // the same two, in words (the server writes them)
  sla_due_at: string | null; ts_recommended: boolean; suppression_reason: string | null;
  normalized?: Record<string, unknown>;
  issue_list?: { field: string | null; rule: string; severity: string; found: unknown; expected: unknown; fix: string | null }[];
  alert_text?: string;
  chat?: { activity_id: string; ts: string; direction: string; kind: string; space_key: string | null; actor: string; text: string; status: string; emoji: string | null }[];
  golden?: { label: string; assessments: { actor: string; at: string; agree: boolean; verdict: string | null; note: string }[] } | null;
}
interface FeedList { cards: FeedCard[]; total: number; legend: ActionDef[]; verdicts: string[] }

const VIEWS: { value: View; label: string }[] = [
  { value: "action", label: "Needs action" }, { value: "review", label: "Review" }, { value: "verified", label: "Verified" },
  { value: "suppressed", label: "Suppressed" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" },
];
const SEVERITY: Record<string, { label: string; tone: "rose" | "violet" }> = { blocking: { label: "Must fix", tone: "rose" }, warning: { label: "Check", tone: "violet" } };

/** Why the alert was held, as sentences. The server sends them in words; plainReason covers older data. */
function heldReasons(c: FeedCard, label: (field: string) => string): string[] {
  return c.review_reasons_plain?.length ? c.review_reasons_plain : c.review_reasons.map((r) => plainReason(r, label));
}

/** How the alert was classified, with Gemini Decisions' probability when there is a real one (never "NaN%"). */
function ClassLine({ c }: { c: NonNullable<FeedCard["classification"]> }) {
  const p = probability(c.probability);
  return (
    <p className="mb-3 text-sm text-zinc-700 dark:text-zinc-300">
      <span className="font-medium text-zinc-900 dark:text-zinc-100">Class: {c.label || "none"}</span>
      {p !== null && <span className="mx-2 text-zinc-500" title={`${c.decided_by || "Gemini Decisions"}' probability for this class`}>{Math.round(p * 100)}% sure</span>}
      {" "}{c.rationale}
    </p>
  );
}

function useRun(onDone: (card: FeedCard | null) => void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, method: "post", url: string, body: unknown, done: string) => {
    setBusy(key);
    try {
      const res = await apiSend<{ summary?: string; card?: FeedCard | null; data?: { user_error?: string } }>(method, url, body);
      if (res.data?.user_error) toast(res.data.user_error, "error");
      else toast(res.summary || done);
      onDone(res.card ?? null);
    } catch (err) {
      toast((err as ApiError).message, "error");
    } finally {
      setBusy(null);
    }
  }, [onDone, toast]);
  return { busy, run };
}

function CardRow({ card, selected, onOpen }: { card: FeedCard; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-current={selected}
      className={cx("block w-full rounded-2xl border p-4 text-left transition-colors",
        selected ? "border-blue-400 bg-blue-50/60 dark:border-blue-300/60 dark:bg-blue-200/10" : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/60",
        card.needs === "sla" && !selected && "glow border-transparent dark:border-transparent")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <CaseBadges status={card.status} verdict={card.verdict} need={card.needs} />
        {card.priority && <Badge tone="zinc">{card.priority}</Badge>}
        <span className="ml-auto text-xs tabular-nums text-zinc-500">{card.needs ? `waiting ${fmtMinutes(card.waiting_min)}` : fmtRelative(card.latest_received_at)}</span>
      </div>
      <p className={cx("mt-2 line-clamp-2 text-sm font-medium", card.alert_name || card.issue_name ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-400")}>
        {card.alert_name || card.issue_name || "No alert name yet"}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span>{card.case_id}</span>{card.platform && <span>{card.platform}</span>}{card.product && <span>{card.product}</span>}{card.exposure_tag && <span className="truncate">{card.exposure_tag}</span>}
        {card.classification && <span>Class: {card.classification.label}</span>}
        <Numbers burson={card.burson} review={card.review_probability} />
      </p>
    </button>
  );
}

function Detail({ caseId, legend, verdicts, onChanged }: { caseId: string; legend: ActionDef[]; verdicts: string[]; onChanged: () => void }) {
  const { me, meta } = useApp();
  const { data, error, loading, setData, reload } = useApi<FeedCard>(`/feed/${caseId}`);
  const done = useCallback((card: FeedCard | null) => { if (card) setData(card); else reload(); onChanged(); }, [setData, reload, onChanged]);
  const { busy, run } = useRun(done);
  const [accept, setAccept] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState("");
  useEffect(() => { setAccept({}); setReason(""); setNote(""); setVerdict(""); }, [caseId]);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const c = data;
  const canAct = !!me?.can_act;
  const label = (f: string) => meta?.field_labels[f] ?? f;
  const proposedCodes = new Set(c.proposed_actions.map((a) => a.code));
  const taken = new Set(c.actions_taken.map((a) => a.code));
  const fields = Object.entries(c.normalized ?? {}).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
  const forwardFields = Object.fromEntries(c.proposed_corrections.filter((p) => accept[p.field] ?? true).map((p) => [p.field, p.new]));

  return (
    <div className="space-y-4">
      <Card title={<span className="flex flex-wrap items-center gap-2">{c.case_id}<CaseBadges status={c.status} verdict={c.verdict} need={c.needs} /></span>}
        subtitle={c.alert_name || c.issue_name || undefined}
        actions={<>
          {c.post_url && <a href={c.post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-200">Post<ExternalLink className="size-3" /></a>}
          <Link to={`/cases/${c.case_id}`} className="text-xs font-medium text-blue-600 dark:text-blue-200">Full case</Link>
        </>}>
        <p className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-700 dark:text-zinc-300"><Numbers burson={c.burson} review={c.review_probability} long /></p>
        {c.classification && <ClassLine c={c.classification} />}
        {c.review_reasons.length > 0 && (
          <Alert tone="violet" title="Why it was held for review" className="mb-3">
            <ul className="list-disc space-y-0.5 pl-4">{heldReasons(c, label).map((r, i) => <li key={i}>{r}</li>)}</ul>
          </Alert>
        )}
        {c.status === "SUPPRESSED" && <Alert tone="blue" title="Why it was not posted" className="mb-3">{c.suppression_label || suppressionLabel(c.suppression_reason)}</Alert>}
        <pre className="scroll-thin max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100 p-3 font-sans text-sm leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">{c.alert_text}</pre>
      </Card>

      {c.status === "NEEDS_REVIEW" && (
        <Card className="glow border-transparent dark:border-transparent" title="Your decision">
          {c.proposed_corrections.length > 0 && (
            <ul className="mb-3 space-y-2">
              {c.proposed_corrections.map((p) => (
                <li key={p.field} className="flex items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-1 size-4 accent-blue-600" checked={accept[p.field] ?? true} disabled={!canAct}
                    onChange={(e) => setAccept((a) => ({ ...a, [p.field]: e.target.checked }))} aria-label={`Apply the proposed ${label(p.field)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{label(p.field)}</span>: <span className="text-zinc-500 line-through">{fmtValue(p.old)}</span> to <span className="font-medium">{fmtValue(p.new)}</span>
                    <span className="ml-2 text-xs text-zinc-500">{probability(p.confidence) !== null ? `${Math.round((probability(p.confidence) ?? 0) * 100)}% likely right` : "no likelihood given: your call"}</span>
                    <span className="block text-xs text-zinc-500">{p.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Field label="Reason (needed to send back)"><Input value={reason} onChange={(e) => setReason(e.target.value)} disabled={!canAct} /></Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={!canAct} loading={busy === "forward"}
              onClick={() => run("forward", "post", `/review-queue/${c.case_id}`, { decision: "forward", reason: reason.trim() || undefined, fields: Object.keys(forwardFields).length ? forwardFields : undefined }, "Forwarded")}>
              {Object.keys(forwardFields).length ? `Apply ${Object.keys(forwardFields).length} and forward` : "Forward as received"}
            </Button>
            <Button disabled={!canAct || !reason.trim()} loading={busy === "bounce"} onClick={() => run("bounce", "post", `/review-queue/${c.case_id}`, { decision: "bounce", reason: reason.trim() }, "Sent back")}>Send back to Burson</Button>
            <Button disabled={!canAct} loading={busy === "suppress"} onClick={() => run("suppress", "post", `/review-queue/${c.case_id}`, { decision: "suppress", reason: reason.trim() || undefined }, "Suppressed")}>Suppress</Button>
          </div>
        </Card>
      )}

      <Card title="Actions" subtitle={c.proposed_actions.length ? "Filled actions are the agent's suggestion." : undefined}>
        <div className="flex flex-wrap gap-2">
          {legend.map((a) => (
            <Button key={a.code} size="sm" disabled={!canAct} loading={busy === a.code} variant={proposedCodes.has(a.code) ? "primary" : "secondary"}
              className={cx(taken.has(a.code) && "opacity-60")} title={taken.has(a.code) ? "Already taken on this case" : undefined}
              onClick={() => run(a.code, "post", `/feed/${c.case_id}/action`, { action: a.code }, a.label)}>{a.label}</Button>
          ))}
        </div>
        {c.ts_recommended && <p className="mt-3 text-xs text-violet-700 dark:text-violet-300">A Trust & Safety escalation is recommended for this alert.</p>}
        {c.actions_taken.length > 0 && (
          <ul className="mt-4 space-y-1 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
            {c.actions_taken.map((a, i) => <li key={i}>{fmtDateTime(a.at)}: {legend.find((l) => l.code === a.code)?.label ?? a.code} by {a.actor}{a.note ? ` (${a.note})` : ""}</li>)}
          </ul>
        )}
      </Card>

      <Card title="Fields" padded={false}
        subtitle={c.field_agreement.assessments > 0 ? `Right column: how often incident managers kept the app's value, from ${c.field_agreement.assessments} assessments in the last ${c.field_agreement.days} days.` : "Once incident managers record assessments, each field shows how often they kept the app's value."}>
        <table className="w-full text-sm">
          <tbody>
            {fields.map(([f, v]) => (
              <tr key={f} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <td className="w-28 px-5 py-2 align-top text-xs text-zinc-500 sm:w-44">{label(f)}</td>
                <td className="break-words px-2 py-2 align-top text-zinc-800 dark:text-zinc-200">{fmtValue(v)}</td>
                <td className="w-40 px-5 py-2 text-right align-top text-xs text-zinc-500">
                  {c.burson?.wrong.includes(f) && <Badge tone="rose">Burson had it wrong</Badge>}
                  {c.burson?.in_question.includes(f) && <Badge tone="violet">In question</Badge>}
                  {c.field_agreement.fields[f] && <span className="block tabular-nums">kept {c.field_agreement.fields[f].kept} of {c.field_agreement.fields[f].of}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {(c.applied_corrections.length > 0 || (c.issue_list?.length ?? 0) > 0) && (
        <Card title="What the agent changed and found">
          <ul className="space-y-2 text-sm">
            {c.applied_corrections.map((p) => (
              <li key={`a-${p.field}`} className="flex items-start gap-2">
                <span className="min-w-0 flex-1"><span className="font-medium">{label(p.field)}</span>: <span className="text-zinc-500 line-through">{fmtValue(p.old)}</span> to {fmtValue(p.new)}
                  {p.reverted_by && <Badge tone="zinc" className="ml-2">reverted by {p.reverted_by}</Badge>}<span className="block text-xs text-zinc-500">{p.reason}</span></span>
                {!p.reverted_by && <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} disabled={!canAct} loading={busy === `rev-${p.field}`}
                  onClick={() => run(`rev-${p.field}`, "post", `/cases/${c.case_id}/revert`, { field: p.field }, "Reverted")}>Revert</Button>}
              </li>
            ))}
            {c.issue_list?.map((i, n) => (
              <li key={`i-${n}`} className="text-zinc-700 dark:text-zinc-300">
                <Badge tone={SEVERITY[i.severity]?.tone ?? "violet"}>{SEVERITY[i.severity]?.label ?? humanize(i.severity)}</Badge> {i.field ? `${label(i.field)}: ` : ""}{i.fix || humanize(i.rule)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {c.citations.length > 0 && (
        <Card title="Knowledge the agent cited">
          <ul className="space-y-3 text-sm">
            {c.citations.map((k) => (
              <li key={k.ref}>
                <p className="font-medium text-zinc-900 dark:text-zinc-100" title={k.ref}>{k.link ? <a className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-200" href={k.link} target="_blank" rel="noreferrer">{k.title}</a> : k.title}</p>
                <p className="mt-0.5 text-xs text-zinc-500">{k.excerpt}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Was the agent right?" subtitle="Your answer is kept as an example the agent is checked against.">
        {c.golden?.assessments.map((a, i) => (
          <p key={i} className="mb-2 text-xs text-zinc-500">{fmtDateTime(a.at)}: {a.actor} {a.agree ? "agreed" : `disagreed${a.verdict ? ` (should be ${verdictLabel(a.verdict)})` : ""}`}{a.note ? `: ${a.note}` : ""}</p>
        ))}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was wrong, or a note" disabled={!canAct} aria-label="Note" />
          <Select value={verdict} onChange={(e) => setVerdict(e.target.value)} disabled={!canAct} aria-label="Correct verdict">
            <option value="">What it should have been (if wrong)</option>{verdicts.map((v) => <option key={v} value={v}>{verdictLabel(v)}</option>)}
          </Select>
        </div>
        <div className="mt-3 flex gap-2">
          <Button icon={<ThumbsUp className="size-4" />} disabled={!canAct} loading={busy === "agree"} onClick={() => run("agree", "post", `/feed/${c.case_id}/assessment`, { agree: true, note }, "Recorded")}>Right</Button>
          <Button icon={<ThumbsDown className="size-4" />} disabled={!canAct || (!note.trim() && !verdict)} loading={busy === "disagree"}
            onClick={() => run("disagree", "post", `/feed/${c.case_id}/assessment`, { agree: false, verdict: verdict || undefined, note }, "Recorded")}>Wrong</Button>
        </div>
      </Card>

      {(c.chat?.length ?? 0) > 0 && (
        <Card title="In Chat" padded={false}>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {c.chat!.map((m) => (
              <li key={m.activity_id} className="px-5 py-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <Badge tone={m.direction === "inbound" ? "blue" : "zinc"}>{m.direction === "inbound" ? "Received" : "Sent"}</Badge>
                  {m.space_key && <span>{TARGET_LABEL[m.space_key] ?? humanize(m.space_key)}</span>}<span>{m.actor}</span><span>{fmtDateTime(m.ts)}</span>
                  {m.status !== "returned" && m.status !== "received" && <Badge tone={m.status === "held" ? "rose" : "zinc"}>{humanize(m.status)}</Badge>}
                </p>
                <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">{m.kind === "reaction" ? `Reaction ${m.emoji ?? ""}` : m.text}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** The two real numbers for an alert: Burson's fields counted against the checks, and Gemini Decisions' chance it needs a person. */
function Numbers({ burson, review: raw, long = false }: { burson: Burson | null; review: number | null; long?: boolean }) {
  const review = probability(raw);
  return (
    <>
      {burson && burson.pct !== null && (
        <span title="Counted: of the fields Burson filled in, how many stood up to the checks">
          Burson {burson.right} of {burson.filled} right ({Math.round(burson.pct * 100)}%){long && burson.in_question.length > 0 ? `, ${burson.in_question.length} in question` : ""}
        </span>
      )}
      {review !== null && <span title="Gemini Decisions' probability that a person needs to look at this alert">{Math.round(review * 100)}% likely to need a person{long ? " (Gemini Decisions)" : ""}</span>}
    </>
  );
}

export default function FeedPage() {
  const { me, toast, refreshCounts } = useApp();
  const { caseId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const view = (search.get("view") as View) || "action";
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [intake, setIntake] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const list = useApi<FeedList>("/feed", { view, q: query, hours: view === "action" ? 72 : 168 }, 60_000);
  const live = useLive(20);
  const { reload } = list;
  useEffect(() => {
    if (!live.lastEventAt) return;
    const id = window.setTimeout(reload, 800);
    return () => window.clearTimeout(id);
  }, [live.lastEventAt, reload]);
  useEffect(() => { const id = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(id); }, [q]);
  const changed = useCallback(() => { reload(); refreshCounts(); }, [reload, refreshCounts]);

  const submit = async () => {
    setSending(true);
    try {
      const res = await apiSend<{ case_id?: string; summary?: string; data?: { user_error?: string } }>("post", "/intake", { text });
      if (res.case_id) { toast(res.summary || `Triaged as ${res.case_id}`); setIntake(false); setText(""); changed(); navigate(`/feed/${res.case_id}`); }
      else toast(res.data?.user_error || res.summary || "That text is not an alert.", "error");
    } catch (err) {
      toast((err as ApiError).message, "error");
    } finally {
      setSending(false);
    }
  };

  const cards = list.data?.cards ?? [];
  return (
    <div>
      <PageHeader title="Review feed"
        actions={<>
          <div className="relative w-full sm:w-auto"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-zinc-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" className="w-full pl-9 sm:w-52" /></div>
          <Segmented label="View" value={view} onChange={(v) => setSearch(v === "action" ? {} : { view: v }, { replace: true })} options={VIEWS} />
          {me?.can_act && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setIntake(true)}>Triage an alert</Button>}
        </>} />
      <ErrorState error={list.error} onRetry={list.reload} />
      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(22rem,2fr)_3fr]">
        <div className={cx("min-w-0 space-y-3", caseId && "hidden xl:block")}>
          {list.loading && !list.data ? <Spinner /> : cards.length === 0 ? (
            <Card><EmptyState icon={<Inbox className="size-8" />} title={view === "action" ? "Nothing is waiting" : "No alerts in this view"}>{view === "action" ? "New alerts appear here the moment they are triaged." : "Try another view or a wider search."}</EmptyState></Card>
          ) : cards.map((c) => <CardRow key={c.case_id} card={c} selected={c.case_id === caseId} onOpen={() => navigate(`/feed/${c.case_id}${search.toString() ? `?${search}` : ""}`)} />)}
          {list.data && list.data.total > cards.length && <p className="text-center text-xs text-zinc-500">Showing {cards.length} of {list.data.total}. Search to narrow.</p>}
        </div>
        <div className={cx("min-w-0", !caseId && "hidden xl:block")}>
          {caseId ? <>
            <button type="button" onClick={() => navigate(`/feed${search.toString() ? `?${search}` : ""}`)} className="mb-3 inline-flex items-center gap-1 text-sm text-blue-600 xl:hidden dark:text-blue-200"><ArrowLeft className="size-4" />Back to the feed</button>
            <Detail key={caseId} caseId={caseId} legend={list.data?.legend ?? []} verdicts={list.data?.verdicts ?? []} onChanged={changed} />
          </> : <Card><EmptyState title="Pick an alert">What the agent found, why, and what you can do about it open here.</EmptyState></Card>}
        </div>
      </div>
      <Modal open={intake} title="Triage an alert" onClose={() => setIntake(false)} wide
        footer={<><Button onClick={() => setIntake(false)}>Cancel</Button><Button variant="primary" loading={sending} disabled={!text.trim()} onClick={submit}>Triage</Button></>}>
        <p className="mb-3 text-sm text-zinc-500">Paste the alert exactly as it was posted. It goes through the same triage as an alert from Chat and becomes a real case.</p>
        <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} aria-label="Alert text" className="font-sans text-sm" />
      </Modal>
    </div>
  );
}
