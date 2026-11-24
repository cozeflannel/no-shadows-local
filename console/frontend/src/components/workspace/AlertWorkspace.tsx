import { ChevronDown, ClipboardCheck, ExternalLink, RefreshCw, ShieldAlert, Sparkles, Thermometer, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { apiSend, type ApiError } from "../../api/client";
import { useApi } from "../../api/hooks";
import type { ActionDef } from "../../api/types";
import { useApp } from "../../context";
import { fmtDateTime, fmtRelative, fmtValue, probability } from "../../lib/format";
import { humanize, plainReason, SOURCE_LABEL, suppressionLabel, TARGET_LABEL } from "../../lib/labels";
import { EventRow } from "../common";
import { Alert, Badge, Button, CaseBadges, cx, ErrorState, Input, Spinner, Tabs } from "../ui";
import { VelocityBadge, type VelocitySummary } from "../VelocityInline";
import { EmailComposer } from "./EmailComposer";
import { checkStatus, EvalLayer, TempCheckLayer, TempCheckNewLayer } from "./Layers";
import { GRADE, type AgentAlert, type Brief, type FeedCard, type QaEval, type QaStanding, type Rubric, type TempView, type TnsView, type Workspace } from "./types";

type Layer = { kind: "temp"; id: string } | { kind: "temp-new" } | { kind: "eval" } | null;
type Tab = "email" | "alert" | "activity";
const SEVERITY: Record<string, { label: string; tone: "rose" | "violet" }> = { blocking: { label: "Must fix", tone: "rose" }, warning: { label: "Check", tone: "violet" } };

// Four fifths of the page to the right of a pinned menu (--nav-w: Layout); the whole page when that would be too narrow to work in.
const SHELL_BOX = {
  left: "calc(var(--nav-w, 0rem) + 0.5rem)",
  width: "min(calc(100vw - var(--nav-w, 0rem) - 1rem), max(calc((100vw - var(--nav-w, 0rem)) * 0.8), 48rem))",
};

/** The window an alert opens in: most of the page, with the list still in view beside it. */
export function Shell({ onClose, header, children, glow = false }: { onClose: () => void; header: ReactNode; children: ReactNode; glow?: boolean }) {
  useEffect(() => {
    // Escape closes what is on top first: with a dialog open over the alert (an incident report, a temp check, a post),
    // the alert stays open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section role="dialog" aria-modal="false" aria-label="Alert" style={SHELL_BOX}
      className={cx("fixed inset-y-2 z-[65] flex flex-col rounded-2xl border bg-zinc-50 shadow-2xl dark:bg-zinc-950",
        glow ? "glow border-transparent" : "border-zinc-200 dark:border-zinc-800")}>
      <header className="flex flex-wrap items-start gap-3 rounded-t-2xl border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        {header}
        <button type="button" aria-label="Close the alert" title="Close (Esc)" onClick={onClose} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-5" /></button>
      </header>
      {children}
    </section>
  );
}

function Box({ title, icon, actions, children, className }: { title: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900", className)}>
      <header className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800/80">
        {icon}<h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-950 dark:text-zinc-50">{title}</h3>{actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A menu that opens under its button and closes when anything else is pressed. */
function Menu({ label, primary = false, glow = false, disabled, children }: { label: ReactNode; primary?: boolean; glow?: boolean; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant={primary ? "primary" : "secondary"} disabled={disabled} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={cx(glow && "glow")}>{label}<ChevronDown className={cx("size-4 transition-transform", open && "rotate-180")} /></Button>
      {open && <>
        <button type="button" aria-label="Close the menu" className="fixed inset-0 z-[70] cursor-default" onClick={() => setOpen(false)} />
        <div className="scroll-thin absolute right-0 top-full z-[71] mt-2 max-h-[70vh] w-[22rem] max-w-[90vw] overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-3 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
          {children(() => setOpen(false))}
        </div>
      </>}
    </div>
  );
}

// -- the brief: a small plain window with just the summary --------------------------------------------------------------------
function BriefWindow({ caseId, brief, busy, onRefresh }: { caseId: string; brief: Brief; busy: boolean; onRefresh: () => void }) {
  const part = (title: string, text: string) => text ? <><p className="mt-3 text-[11px] uppercase tracking-wide text-zinc-500">{title}</p><p className="mt-0.5">{text}</p></> : null;
  return (
    <section aria-label="Brief" className="overflow-hidden rounded-xl border border-zinc-300 shadow-sm dark:border-zinc-700">
      <header className="flex items-center gap-2 border-b border-zinc-300 bg-zinc-200/80 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-800">
        <span aria-hidden className="flex gap-1"><i className="size-2.5 rounded-full bg-rose-400" /><i className="size-2.5 rounded-full bg-zinc-400" /><i className="size-2.5 rounded-full bg-emerald-500" /></span>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-[11px] text-zinc-600 dark:text-zinc-300">brief-{caseId.toLowerCase()}.txt</span>
        <button type="button" onClick={onRefresh} disabled={busy} title="Write it again" aria-label="Write the brief again" className="rounded p-0.5 text-zinc-500 hover:bg-zinc-300 disabled:opacity-50 dark:hover:bg-zinc-700">
          <RefreshCw className={cx("size-3.5", busy && "animate-spin")} />
        </button>
      </header>
      <div className="bg-white px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
        <p className="font-semibold text-zinc-950 dark:text-zinc-50">{brief.headline}</p>
        {part("What it says", brief.saying)}
        {part("Where it stands", brief.happening)}
        {brief.next_steps.length > 0 && <>
          <p className="mt-3 text-[11px] uppercase tracking-wide text-zinc-500">To do</p>
          <ul className="mt-0.5 space-y-0.5">{brief.next_steps.map((s) => <li key={s} className="flex gap-1.5"><span aria-hidden>▸</span><span>{s}</span></li>)}</ul>
        </>}
        {brief.watch.length > 0 && <>
          <p className="mt-3 text-[11px] uppercase tracking-wide text-zinc-500">Check twice</p>
          <ul className="mt-0.5 space-y-0.5">{brief.watch.map((s) => <li key={s} className="flex gap-1.5"><span aria-hidden>!</span><span>{s}</span></li>)}</ul>
        </>}
        <p className="mt-3 border-t border-dashed border-zinc-300 pt-2 text-[11px] text-zinc-500 dark:border-zinc-700">
          {busy ? "Gemini is writing…" : brief.by === "gemini" ? `Worded by Gemini${brief.at ? ` ${fmtRelative(brief.at)}` : ""}. The to-do list and every figure come from the alert itself.` : "Read straight from the alert (no model)."}
        </p>
      </div>
    </section>
  );
}

// -- header menus -----------------------------------------------------------------------------------------------------------
function ActionsMenu({ card, legend, canAct, onApply, busy }: { card: FeedCard; legend: ActionDef[]; canAct: boolean; onApply: (codes: string[]) => Promise<void>; busy: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const taken = new Set(card.actions_taken.map((a) => a.code));
  const suggested = new Set(card.proposed_actions.map((a) => a.code));
  const order = [...legend].sort((a, b) => Number(suggested.has(b.code)) - Number(suggested.has(a.code)));
  return (
    <Menu label={<>Actions{taken.size > 0 && <span className="rounded-full bg-zinc-200 px-1.5 text-xs tabular-nums text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100">{taken.size} taken</span>}</>} disabled={!canAct && taken.size === 0}>
      {(close) => (
        <div>
          <p className="px-1 pb-2 text-xs text-zinc-500">Tick what you did or want done, then apply. Each one is recorded on the alert as an emoji in Chat would be.</p>
          <ul className="space-y-0.5">
            {order.map((a) => (
              <li key={a.code}>
                <label className={cx("flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800", taken.has(a.code) && "opacity-60")}>
                  <input type="checkbox" className="mt-0.5 size-4 accent-blue-600" disabled={!canAct || taken.has(a.code)} checked={taken.has(a.code) || picked.includes(a.code)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.code] : p.filter((x) => x !== a.code)))} />
                  <span className="min-w-0 flex-1"><span aria-hidden className="mr-1.5">{a.emoji}</span>{a.label}
                    {taken.has(a.code) && <span className="ml-2 text-xs text-zinc-500">taken</span>}
                    {suggested.has(a.code) && !taken.has(a.code) && <Badge tone="blue" className="ml-2">Suggested</Badge>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <Button size="sm" onClick={close}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!canAct || picked.length === 0} loading={busy} onClick={async () => { await onApply(picked); setPicked([]); close(); }}>
              Apply {picked.length || ""}
            </Button>
          </div>
        </div>
      )}
    </Menu>
  );
}

function DecisionMenu({ card, canAct, busy, label, onDecide }: {
  card: FeedCard; canAct: boolean; busy: string; label: (f: string) => string;
  onDecide: (decision: "forward" | "bounce" | "suppress", reason: string, fields: Record<string, unknown>) => Promise<void>;
}) {
  const [accept, setAccept] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const fields = Object.fromEntries(card.proposed_corrections.filter((p) => accept[p.field] ?? true).map((p) => [p.field, p.new]));
  const n = Object.keys(fields).length;
  return (
    <Menu label="Decide" primary glow disabled={!canAct}>
      {(close) => (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">This alert is held for a person. Send it on, send it back to Burson, or suppress it.</p>
          {card.proposed_corrections.length > 0 && (
            <ul className="space-y-2">
              {card.proposed_corrections.map((p) => (
                <li key={p.field} className="flex items-start gap-2.5 text-sm">
                  <input type="checkbox" className="mt-1 size-4 accent-blue-600" checked={accept[p.field] ?? true}
                    onChange={(e) => setAccept((a) => ({ ...a, [p.field]: e.target.checked }))} aria-label={`Apply the proposed ${label(p.field)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{label(p.field)}</span>: <span className="text-zinc-500 line-through">{fmtValue(p.old)}</span> to <span className="font-medium">{fmtValue(p.new)}</span>
                    <span className="block text-xs text-zinc-500">{p.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (needed to send it back)" aria-label="Reason" />
          <div className="flex flex-col gap-2">
            <Button variant="primary" loading={busy === "forward"} onClick={async () => { await onDecide("forward", reason, fields); close(); }}>{n ? `Apply ${n} and send it on` : "Send it on as received"}</Button>
            <Button disabled={!reason.trim()} loading={busy === "bounce"} onClick={async () => { await onDecide("bounce", reason, {}); close(); }}>Send back to Burson</Button>
            <Button loading={busy === "suppress"} onClick={async () => { await onDecide("suppress", reason, {}); close(); }}>Suppress</Button>
          </div>
        </div>
      )}
    </Menu>
  );
}

// -- the cards on the right ---------------------------------------------------------------------------------------------------
function TnsPanel({ tns, canAct, busy, onAct }: { tns: TnsView; canAct: boolean; busy: string; onAct: (action: "prepare" | "submitted" | "discard") => void }) {
  const s = tns.state;
  const open = s?.prefill_url && (
    <a href={s.prefill_url} target="_blank" rel="noreferrer"
      className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-200 dark:text-blue-900 dark:hover:bg-blue-100">
      Open the filled-in form<ExternalLink className="size-3.5" />
    </a>
  );
  const status = !s ? null : s.status === "SUBMITTED" ? <Badge tone="emerald">Submitted</Badge> : s.status === "WITHDRAWN" ? <Badge tone="zinc">Discarded</Badge>
    : s.status === "NOT_ELIGIBLE" ? <Badge tone="zinc">Probably not for T&S</Badge> : <Badge tone="violet">Form ready</Badge>;
  return (
    <Box title="Trust & Safety" icon={<ShieldAlert className="size-4 text-zinc-400" />} actions={status}>
      {!s && (busy === "prepare" ? <Spinner label="Judging it and filling in the form…" /> : (
        <div className="space-y-2 text-sm">
          <p className="text-zinc-700 dark:text-zinc-300">{tns.recommended ? `The agent recommends a report${tns.reasons.length ? `: ${tns.reasons.join(", ")}` : ""}.` : "The agent did not recommend a report for this alert."}</p>
          <Button size="sm" disabled={!canAct} onClick={() => onAct("prepare")}>{tns.recommended ? "Fill in the form" : "Check it anyway and fill in the form"}</Button>
        </div>
      ))}
      {s && (s.status === "PREPARED" || s.status === "NOT_ELIGIBLE") && (
        <div className="space-y-2.5 text-sm">
          <p className="text-zinc-700 dark:text-zinc-300">{s.eligible ? `Meets the criteria${s.category ? ` · ${s.category}` : ""}.` : "It does not seem to meet the criteria; submit it only if you disagree."}{s.urgent && <Badge tone="rose" className="ml-2">Urgent</Badge>}</p>
          {s.rationale && <p className="text-xs text-zinc-500">{s.rationale}</p>}
          {s.criteria_ids.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-zinc-500">{s.criteria_ids.map((id) => <li key={id}>{tns.criteria[id] ?? humanize(id)}</li>)}</ul>}
          {s.evidence !== "input_shown" && s.evidence !== "replicable" && <p className="text-xs text-violet-700 dark:text-violet-300">Evidence needed: attach a screenshot showing the input, or replicate the issue, before you submit.</p>}
          {tns.unverified_form && <p className="text-xs text-violet-700 dark:text-violet-300">The form's field ids are not all verified yet: check every filled-in value before you submit.</p>}
          {open}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!canAct} loading={busy === "submitted"} onClick={() => onAct("submitted")}>I submitted it</Button>
            <Button size="sm" variant="ghost" disabled={!canAct} loading={busy === "discard"} onClick={() => onAct("discard")}>Discard</Button>
          </div>
          {!tns.mine && tns.by && <p className="text-xs text-zinc-500">Filled in for {tns.by}.</p>}
        </div>
      )}
      {s && s.status === "SUBMITTED" && (
        <div className="space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
          <p>Submitted {fmtDateTime(s.submitted_at)}{s.submitted_by ? ` by ${s.submitted_by}` : ""}.</p>
          {s.wd_issue_id && <p className="text-xs text-zinc-500">Watchdog issue {s.wd_issue_id}</p>}
          {s.outcome && <p className="text-xs text-zinc-500">Outcome: {s.outcome}{s.bug_id ? ` · b/${s.bug_id}` : ""}</p>}
        </div>
      )}
      {s && s.status === "WITHDRAWN" && (
        <div className="space-y-2 text-sm"><p className="text-zinc-500">The form was discarded.</p><Button size="sm" disabled={!canAct} loading={busy === "prepare"} onClick={() => onAct("prepare")}>Fill it in again</Button></div>
      )}
    </Box>
  );
}

function TempPanel({ temp, canAct, onOpen, onNew }: { temp: TempView; canAct: boolean; onOpen: (id: string) => void; onNew: () => void }) {
  return (
    <Box title="Temp checks" icon={<Thermometer className="size-4 text-zinc-400" />} actions={temp.checks.length > 0 && <Badge tone="zinc">{temp.checks.length}</Badge>}>
      {temp.checks.length === 0 ? <p className="text-sm text-zinc-500">{temp.auto ? "None yet. The agent starts one on its own when an alert calls for it." : "None for this alert yet."}</p> : (
        <ul className="space-y-1.5">
          {temp.checks.map((c) => (
            <li key={c.check_id}>
              <button type="button" onClick={() => onOpen(c.check_id)} className="block w-full rounded-xl border border-zinc-200 px-3 py-2 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60">
                <span className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100"><span className="min-w-0 flex-1 truncate">{c.title || c.issue}</span><Badge tone={checkStatus(c.status).tone}>{checkStatus(c.status).label}</Badge></span>
                <span className="mt-0.5 block text-xs text-zinc-500">{fmtRelative(c.created_at)} · {c.trigger === "manual" ? `by ${c.requested_by}` : "started by the agent"}{c.concern_level ? ` · ${c.concern_level}` : ""}{c.doc_url ? " · has a document" : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" className="mt-3" disabled={!canAct} onClick={onNew}>Run a temp check</Button>
      {!temp.enabled && <p className="mt-2 text-xs text-zinc-500">Temp checks are switched off (Settings, Switches).</p>}
    </Box>
  );
}

function QaPanel({ evals, rubric, standing, canAct, onOpen, what }: { evals: QaEval[]; rubric: Rubric; standing: QaStanding; canAct: boolean; onOpen: () => void; what: string }) {
  const last = evals[0];  // the evaluation that stands: one person evaluates an alert
  const taught = last ? last.steps.filter((s) => s.kind === "lesson" && s.status !== "rejected") : [];
  const inUse = taught.filter((s) => s.status === "applied").length;
  return (
    <Box title="Chatbot QA" icon={<ClipboardCheck className="size-4 text-zinc-400" />} actions={last && last.revision > 0 && <Badge tone="zinc">revised</Badge>}>
      {last ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xl font-medium tabular-nums text-zinc-950 dark:text-zinc-50">{last.score ?? "n/a"}</span><span className="text-zinc-500">of 100</span>
          <Badge tone={(GRADE[last.grade] ?? GRADE[""]).tone}>{(GRADE[last.grade] ?? GRADE[""]).label}</Badge>
          <span className="w-full text-xs text-zinc-500">{standing.mine ? "You" : last.evaluator} · {fmtRelative(last.at)} · {taught.length === 0 ? "no lesson" : `${inUse} of ${taught.length} ${taught.length === 1 ? "lesson" : "lessons"} in use`}</span>
        </p>
      ) : <p className="text-sm text-zinc-500">Nobody has graded {what} yet. {rubric.criteria.length} things to rate; it takes a minute. One person evaluates an alert.</p>}
      <Button size="sm" className="mt-3" variant={last ? "secondary" : "primary"} onClick={onOpen}>{!last ? "Grade the chatbot's work" : standing.mine && canAct ? "Revise your evaluation" : "See the evaluation"}</Button>
    </Box>
  );
}

// -- an alert (a case) ----------------------------------------------------------------------------------------------------------
export function AlertWorkspace({ caseId, velocity, onVelocityUpdated, onClose, onChanged, extra }: {
  caseId: string; velocity?: VelocitySummary | null; onVelocityUpdated?: (s: VelocitySummary) => void; onClose: () => void; onChanged: () => void;
  extra?: ReactNode;  // buttons the page adds to the window's own (the incident report)
}) {
  const { meta, toast } = useApp();
  const { data, error, loading, reload, setData } = useApi<Workspace>(`/workspace/${caseId}`);
  const [tab, setTab] = useState<Tab>("email");
  const [layer, setLayer] = useState<Layer>(null);
  const [busy, setBusy] = useState("");
  const asked = useRef({ brief: false, tns: false });
  const label = (f: string) => meta?.field_labels[f] ?? f;
  const closeLayer = useCallback(() => setLayer(null), []);

  const send = useCallback(async (key: string, method: "post" | "put", url: string, body: unknown, done: string): Promise<boolean> => {
    setBusy(key);
    try {
      const res = await apiSend<{ summary?: string; data?: { user_error?: string } }>(method, url, body);
      if (res.data?.user_error) { toast(res.data.user_error, "error"); return false; }
      toast(res.summary || done);
      reload(); onChanged();
      return true;
    } catch (err) { toast((err as ApiError).message, "error"); return false; } finally { setBusy(""); }
  }, [onChanged, reload, toast]);

  // The newest copy of what is shown: an answer that arrives late is laid over that, never over what it was asked from.
  const latest = useRef<Workspace | null>(null);
  latest.current = data;
  const patch = useCallback((part: Partial<Workspace>) => { if (latest.current) setData({ ...latest.current, ...part }); }, [setData]);

  const writeBrief = useCallback(async (refresh: boolean) => {
    setBusy("brief");
    try {
      patch({ brief: await apiSend<Brief>("post", `/workspace/${caseId}/brief`, { refresh }) });
    } catch (err) { if (refresh) toast((err as ApiError).message, "error"); } finally { setBusy((b) => (b === "brief" ? "" : b)); }
  }, [caseId, patch, toast]);
  const actTns = useCallback(async (action: "prepare" | "submitted" | "discard", quiet = false) => {
    setBusy(action);
    try {
      const res = await apiSend<{ tns: TnsView }>("post", `/workspace/${caseId}/tns`, { action });
      patch({ tns: res.tns });
      if (!quiet) toast(action === "prepare" ? "The form is filled in" : action === "submitted" ? "Marked as submitted" : "Discarded");
      onChanged();
    } catch (err) { if (!quiet) toast((err as ApiError).message, "error"); } finally { setBusy((b) => (b === action ? "" : b)); }
  }, [caseId, onChanged, patch, toast]);

  // On opening: Gemini words the brief, and a Trust & Safety form the agent recommended is filled in, once each.
  useEffect(() => {
    if (!data) return;
    if (data.brief.stale && !asked.current.brief) { asked.current.brief = true; void writeBrief(false); }
    else if (data.can_act && data.tns.recommended && !data.tns.state && !asked.current.tns && busy !== "brief") { asked.current.tns = true; void actTns("prepare", true); }
  }, [data, busy, writeBrief, actTns]);

  const header = (c: FeedCard | undefined) => (
    <>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">{caseId}</span>
          {c && <><CaseBadges status={c.status} verdict={c.verdict} need={c.needs} />{c.priority && <Badge tone="zinc">{c.priority}</Badge>}
            {c.source && <Badge tone="zinc">{SOURCE_LABEL[c.source] ?? humanize(c.source)}</Badge>}
            <span>{c.needs ? `waiting since ${fmtRelative(c.latest_received_at)}` : `received ${fmtRelative(c.latest_received_at)}`}</span></>}
        </p>
        <h2 className="mt-0.5 truncate text-lg font-medium tracking-tight text-zinc-950 dark:text-zinc-50" title={c?.alert_name ?? ""}>{c ? c.alert_name || c.issue_name || "No alert name yet" : "Opening…"}</h2>
      </div>
      {c && data && (
        <div className="flex flex-wrap items-center gap-2">
          <VelocityBadge summary={velocity} caseId={c.case_id} postUrl={c.post_url} onUpdated={onVelocityUpdated} />
          {c.post_url && <a href={c.post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-200 dark:hover:bg-zinc-800">Post<ExternalLink className="size-3.5" /></a>}
          {c.status === "NEEDS_REVIEW" && (
            <DecisionMenu card={c} canAct={data.can_act} busy={busy} label={label}
              onDecide={async (decision, reason, fields) => { await send(decision, "post", `/review-queue/${c.case_id}`, { decision, reason: reason.trim() || undefined, fields: Object.keys(fields).length ? fields : undefined }, "Decided"); }} />
          )}
          {extra}
          <ActionsMenu card={c} legend={data.legend} canAct={data.can_act} busy={busy === "actions"}
            onApply={async (codes) => { for (const code of codes) { if (!(await send("actions", "post", `/feed/${c.case_id}/action`, { action: code }, "Recorded"))) break; } }} />
        </div>
      )}
    </>
  );

  const c = data?.card;
  const fields = Object.entries(c?.normalized ?? {}).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
  const held = c ? (c.review_reasons_plain?.length ? c.review_reasons_plain : c.review_reasons.map((r) => plainReason(r, label))) : [];
  return (
    <Shell onClose={onClose} header={header(c)}>
      {loading && !data ? <Spinner /> : error && !data ? <div className="p-5"><ErrorState error={error} onRetry={reload} /></div> : null}
      {data && c && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[17rem_minmax(0,1fr)_19rem] lg:overflow-hidden">
          {/* left: what this is */}
          <div className="scroll-thin min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1">
            <BriefWindow caseId={caseId} brief={data.brief} busy={busy === "brief"} onRefresh={() => writeBrief(true)} />
            {held.length > 0 && c.status === "NEEDS_REVIEW" && <Alert tone="violet" title="Why it is held"><ul className="list-disc space-y-0.5 pl-4">{held.map((r, i) => <li key={i}>{r}</li>)}</ul></Alert>}
            {c.status === "SUPPRESSED" && <Alert tone="blue" title="Why it was not posted">{c.suppression_label || suppressionLabel(c.suppression_reason)}</Alert>}
            <Box title="Details">
              <dl className="space-y-2 text-sm">
                {data.brief.facts.map((f) => (
                  <div key={f.label}><dt className="text-xs text-zinc-500">{f.label}</dt><dd className="break-words text-zinc-900 dark:text-zinc-100">{f.value}</dd></div>
                ))}
                {c.author && <div><dt className="text-xs text-zinc-500">Author</dt><dd className="break-words text-zinc-900 dark:text-zinc-100">{c.author}</dd></div>}
                {c.classification && <div><dt className="text-xs text-zinc-500">Class</dt><dd className="text-zinc-900 dark:text-zinc-100">{c.classification.label || "none"}
                  {probability(c.classification.probability) !== null && <span className="ml-1.5 text-xs text-zinc-500">{Math.round((probability(c.classification.probability) ?? 0) * 100)}% sure</span>}</dd></div>}
                {c.burson && c.burson.pct !== null && <div><dt className="text-xs text-zinc-500">Burson's fields</dt><dd className="tabular-nums text-zinc-900 dark:text-zinc-100" title="Counted: of the fields Burson filled in, how many stood up to the checks">{c.burson.right} of {c.burson.filled} right ({Math.round(c.burson.pct * 100)}%)</dd></div>}
                {c.review_probability !== null && <div><dt className="text-xs text-zinc-500">Likely to need a person</dt><dd className="tabular-nums text-zinc-900 dark:text-zinc-100" title="Gemini Decisions' probability that a person needs to look at this alert">{Math.round(c.review_probability * 100)}% <span className="text-xs text-zinc-500">(Gemini Decisions)</span></dd></div>}
              </dl>
              <Link to={`/cases/${c.case_id}`} className="mt-3 inline-block text-xs font-medium text-blue-600 dark:text-blue-200">Full case record</Link>
            </Box>
          </div>

          {/* middle: the work */}
          <div className="scroll-thin min-h-0 lg:overflow-y-auto lg:pr-1">
            <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ key: "email", label: "Email" }, { key: "alert", label: "Alert" }, { key: "activity", label: "Activity", count: data.events.length }]} />
            {tab === "email" && <EmailComposer key={caseId} caseId={caseId} email={data.email} canAct={data.can_act} onSaved={(email) => { patch({ email }); onChanged(); }} />}
            {tab === "alert" && (
              <div className="space-y-4">
                <Box title="The alert as it was posted">
                  <pre className="scroll-thin max-h-[26rem] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{c.alert_text}</pre>
                </Box>
                {(c.applied_corrections.length > 0 || (c.issue_list?.length ?? 0) > 0) && (
                  <Box title="What the agent changed and found">
                    <ul className="space-y-2 text-sm">
                      {c.applied_corrections.map((p) => (
                        <li key={`a-${p.field}`} className="flex items-start gap-2">
                          <span className="min-w-0 flex-1"><span className="font-medium">{label(p.field)}</span>: <span className="text-zinc-500 line-through">{fmtValue(p.old)}</span> to {fmtValue(p.new)}
                            {p.reverted_by && <Badge tone="zinc" className="ml-2">reverted by {p.reverted_by}</Badge>}<span className="block text-xs text-zinc-500">{p.reason}</span></span>
                          {!p.reverted_by && <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} disabled={!data.can_act} loading={busy === `rev-${p.field}`}
                            onClick={() => send(`rev-${p.field}`, "post", `/cases/${c.case_id}/revert`, { field: p.field }, "Reverted")}>Revert</Button>}
                        </li>
                      ))}
                      {c.issue_list?.map((i, n) => (
                        <li key={`i-${n}`} className="text-zinc-700 dark:text-zinc-300">
                          <Badge tone={SEVERITY[i.severity]?.tone ?? "violet"}>{SEVERITY[i.severity]?.label ?? humanize(i.severity)}</Badge> {i.field ? `${label(i.field)}: ` : ""}{i.fix || humanize(i.rule)}
                        </li>
                      ))}
                    </ul>
                  </Box>
                )}
                <Box title="Fields">
                  <p className="mb-2 text-xs text-zinc-500">
                    {c.field_agreement.assessments > 0 ? `Kept: how often incident managers kept the app's value, from ${c.field_agreement.assessments} assessments in the last ${c.field_agreement.days} days.`
                      : "Once incident managers record assessments, each field shows how often they kept the app's value."}
                  </p>
                  <table className="w-full text-sm">
                    <tbody>
                      {fields.map(([f, v]) => (
                        <tr key={f} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                          <td className="w-40 py-1.5 pr-3 align-top text-xs text-zinc-500">{label(f)}</td>
                          <td className="break-words py-1.5 align-top text-zinc-800 dark:text-zinc-200">{fmtValue(v)}
                            {c.burson?.wrong.includes(f) && <Badge tone="rose" className="ml-2">Burson had it wrong</Badge>}
                            {c.burson?.in_question.includes(f) && <Badge tone="violet" className="ml-2">In question</Badge>}
                            {c.field_agreement.fields[f] && <span className="ml-2 whitespace-nowrap text-xs tabular-nums text-zinc-500">kept {c.field_agreement.fields[f].kept} of {c.field_agreement.fields[f].of}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Box>
                {c.citations.length > 0 && (
                  <Box title="Knowledge the agent cited">
                    <ul className="space-y-3 text-sm">{c.citations.map((k) => (
                      <li key={k.ref}><p className="font-medium text-zinc-900 dark:text-zinc-100">{k.link ? <a className="text-blue-600 hover:underline dark:text-blue-200" href={k.link} target="_blank" rel="noreferrer">{k.title}</a> : k.title}</p>
                        <p className="mt-0.5 text-xs text-zinc-500">{k.excerpt}</p></li>))}</ul>
                  </Box>
                )}
              </div>
            )}
            {tab === "activity" && (
              <div className="space-y-4">
                <Box title="Timeline"><ul>{[...data.events].reverse().map((e) => <EventRow key={e.event_id} event={e} compact showCase={false} />)}</ul>
                  {data.events.length === 0 && <p className="text-sm text-zinc-500">Nothing recorded yet.</p>}</Box>
                {(c.chat?.length ?? 0) > 0 && (
                  <Box title="In Chat">
                    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {c.chat!.map((m) => (
                        <li key={m.activity_id} className="py-2.5 text-sm">
                          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <Badge tone={m.direction === "inbound" ? "blue" : "zinc"}>{m.direction === "inbound" ? "Received" : "Sent"}</Badge>
                            {m.space_key && <span>{TARGET_LABEL[m.space_key] ?? humanize(m.space_key)}</span>}<span>{m.actor}</span><span>{fmtDateTime(m.ts)}</span>
                          </p>
                          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">{m.kind === "reaction" ? `Reaction ${m.emoji ?? ""}` : m.text}</p>
                        </li>
                      ))}
                    </ul>
                  </Box>
                )}
              </div>
            )}
          </div>

          {/* right: what goes with it */}
          <div className="scroll-thin min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1">
            <TnsPanel tns={data.tns} canAct={data.can_act} busy={busy} onAct={(a) => void actTns(a)} />
            <TempPanel temp={data.temp} canAct={data.can_act} onOpen={(id) => setLayer({ kind: "temp", id })} onNew={() => setLayer({ kind: "temp-new" })} />
            <QaPanel evals={data.qa.evals} rubric={data.qa.rubric} standing={data.qa.standing} canAct={data.can_act} onOpen={() => setLayer({ kind: "eval" })} what="the chatbot's review of this alert" />
            {c.actions_taken.length > 0 && (
              <Box title="Actions taken">
                <ul className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  {c.actions_taken.map((a, i) => <li key={i}><span className="font-medium text-zinc-800 dark:text-zinc-200">{data.legend.find((l) => l.code === a.code)?.label ?? humanize(a.code)}</span> · {a.actor} · {fmtDateTime(a.at)}{a.note ? ` (${a.note})` : ""}</li>)}
                </ul>
              </Box>
            )}
          </div>
        </div>
      )}
      {data && layer?.kind === "temp" && <TempCheckLayer key={layer.id} id={layer.id} canAct={data.can_act} onClose={closeLayer} onChanged={reload} onOpen={(id) => setLayer({ kind: "temp", id })} />}
      {data && c && layer?.kind === "temp-new" && <TempCheckNewLayer caseId={caseId} issue={c.issue_name || c.alert_name || ""} canAct={data.can_act} onClose={closeLayer}
        onDone={(id) => { reload(); setLayer({ kind: "temp", id }); }} />}
      {data && c && layer?.kind === "eval" && <EvalLayer subjectType="case" subjectId={caseId} title={`${caseId} · ${c.alert_name || c.issue_name || ""}`}
        rubric={data.qa.rubric} evals={data.qa.evals} standing={data.qa.standing} verdicts={data.verdicts} canAct={data.can_act} onClose={closeLayer} onSubmitted={() => { reload(); onChanged(); }} />}
    </Shell>
  );
}

// -- an alert the agent raised itself ----------------------------------------------------------------------------------------------
const pathLabel = (path: string) => path.split("_").filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(" ");

/** Why the review looked at it, in a few words. */
function agentReason(d: AgentAlert): string {
  const rule = d.rule ? `${d.rule}${d.section ? ` (${d.section})` : ""}` : "";
  if (d.trigger === "MET_IN_CODE") return rule ? `Mandatory rule: ${rule}` : "Raised by another tool in the Other alerts space";
  if (d.trigger === "FOLLOWUP_SURGE") return "A story already raised that is growing again";
  if (d.item_type === "STORY") return "A fast-growing story that no rule covers";
  return rule ? `Rule: ${rule}` : "";
}

export function AgentAlertWorkspace({ alert, canAct, onClose, onChanged }: { alert: AgentAlert; canAct: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useApp();
  const qa = useApi<{ rubric: Rubric; evals: QaEval[]; standing: QaStanding }>("/qa-evals/subject", { subject_type: "agent_alert", subject_id: alert.id });
  const [layer, setLayer] = useState<Layer>(null);
  const [busy, setBusy] = useState("");
  const [verdict, setVerdict] = useState(alert.verdict);
  useEffect(() => { setVerdict(alert.verdict); }, [alert.verdict]);  // recorded from a link in Chat, or by someone else
  const raised = alert.status !== "passed";
  const closeLayer = useCallback(() => setLayer(null), []);
  const judge = async (v: "TRUE_POSITIVE" | "FALSE_POSITIVE") => {
    setBusy(v);
    try {
      await apiSend("post", `/own/decisions/${alert.id}/verdict`, { verdict: v });
      setVerdict(v); toast(v === "TRUE_POSITIVE" ? "Confirmed" : "Marked as a false positive"); onChanged();
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const posts = alert.evidence.split(" || ").map((x) => x.trim()).filter(Boolean);
  const story = alert.item_type === "STORY";
  const reason = agentReason(alert);
  return (
    <Shell glow={raised} onClose={onClose} header={
      <>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {raised ? <Badge tone="violet"><Sparkles className="size-3" />Agent alert</Badge> : <Badge tone="zinc"><Sparkles className="size-3" />Not raised</Badge>}
            {alert.severity && <Badge tone={alert.severity === "P0" ? "rose" : "zinc"}>{alert.severity}</Badge>}{alert.path && <Badge tone="blue" title="Who it goes to">{pathLabel(alert.path)}</Badge>}
            <Badge tone="zinc">{story ? "Story" : "Post"}</Badge>
            {verdict && <Badge tone={verdict === "TRUE_POSITIVE" ? "emerald" : "zinc"}>{verdict === "TRUE_POSITIVE" ? "Confirmed" : "False positive"}</Badge>}
            <span>{raised ? "raised" : "looked at"} {fmtRelative(alert.at)}</span>
          </p>
          <h2 className="mt-0.5 line-clamp-2 text-lg font-medium tracking-tight text-zinc-950 dark:text-zinc-50">{alert.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={verdict === "TRUE_POSITIVE" ? "success" : "secondary"} disabled={!canAct} loading={busy === "TRUE_POSITIVE"} onClick={() => judge("TRUE_POSITIVE")}>Confirm</Button>
          <Button disabled={!canAct} loading={busy === "FALSE_POSITIVE"} onClick={() => judge("FALSE_POSITIVE")}>False positive</Button>
        </div>
      </>}>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:overflow-hidden">
        <div className="scroll-thin min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1">
          <Box title={raised ? "Why the agent raised it" : "Why the agent did not raise it"}>
            {reason && <p className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{reason}</p>}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{alert.rationale || "No reasoning was kept."}</p>
            {alert.velocity && <p className="mt-2 text-xs text-zinc-500">Pace: {alert.velocity}</p>}
            <p className="mt-2 text-xs text-zinc-500">
              {alert.kof ? `${story ? "KOF in the story" : "Posted by a KOF"}: ${alert.kof}` : `${story ? "No author in the story is" : "The author is not"} on the KOF list. Personal details were removed.`}
            </p>
            <p className="mt-1 text-xs text-zinc-500">Checked by Gemini.{raised && (alert.posted_to ? " Posted in Chat." : " Not posted in Chat.")}{alert.note && ` ${alert.note}`}</p>
          </Box>
          <Box title={`What it read${posts.length ? ` (${posts.length})` : ""}`}>
            {posts.length === 0 ? <p className="text-sm text-zinc-500">No posts were kept with it.</p>
              : <ul className="space-y-2">{posts.map((p, i) => <li key={i} className="rounded-xl bg-zinc-100 p-3 text-sm text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-200">{p}</li>)}</ul>}
            {alert.links.length > 0 && (
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {alert.links.map((l, i) => (
                  <a key={l} href={l} target="_blank" rel="noreferrer" title={l} className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-200">
                    <ExternalLink className="size-3.5" aria-hidden />{story ? `Post ${i + 1}` : "Open the post"}
                  </a>
                ))}
              </p>
            )}
          </Box>
        </div>
        <div className="scroll-thin min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1">
          <Box title="Your verdict">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{verdict ? `Recorded as ${verdict === "TRUE_POSITIVE" ? "confirmed" : "a false positive"}${alert.verdict_by && verdict === alert.verdict ? ` by ${alert.verdict_by}${alert.verdict_at ? `, ${fmtDateTime(alert.verdict_at)}` : ""}` : ""}.` : "Not judged yet. Confirm it, or mark it a false positive: the agent's reviewer is shown your verdict on alerts like it."}</p>
            {alert.posted_to && <p className="mt-2 text-xs text-zinc-500">Posted in {alert.posted_to}.</p>}
          </Box>
          {qa.data && <QaPanel evals={qa.data.evals} rubric={qa.data.rubric} standing={qa.data.standing} canAct={canAct} onOpen={() => setLayer({ kind: "eval" })} what="this alert" />}
          <Box title="Temp check" icon={<Thermometer className="size-4 text-zinc-400" />}>
            <p className="text-sm text-zinc-500">See how big this conversation is right now.</p>
            <Button size="sm" className="mt-3" disabled={!canAct} onClick={() => setLayer({ kind: "temp-new" })}>Run a temp check</Button>
          </Box>
          <p className="text-xs text-zinc-500">
            What the agent alerts on is set in Settings: its <Link to="/settings/own-sources" className="font-medium text-blue-600 dark:text-blue-200">sources</Link> and
            its <Link to="/settings/own-rules" className="font-medium text-blue-600 dark:text-blue-200">rules</Link>.
          </p>
        </div>
      </div>
      {layer?.kind === "temp-new" && <TempCheckNewLayer issue={alert.title} canAct={canAct} onClose={closeLayer} onDone={(id) => setLayer({ kind: "temp", id })} />}
      {layer?.kind === "temp" && <TempCheckLayer key={layer.id} id={layer.id} canAct={canAct} onClose={closeLayer} onChanged={() => undefined} onOpen={(id) => setLayer({ kind: "temp", id })} />}
      {layer?.kind === "eval" && qa.data && <EvalLayer subjectType="agent_alert" subjectId={alert.id} title={alert.title} rubric={qa.data.rubric}
        evals={qa.data.evals} standing={qa.data.standing} verdicts={[]} canAct={canAct} onClose={closeLayer} onSubmitted={() => { qa.reload(); onChanged(); }} />}
    </Shell>
  );
}
