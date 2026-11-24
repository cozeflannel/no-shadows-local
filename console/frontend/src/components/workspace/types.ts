import type { ActionDef, AgentEvent, TnsState } from "../../api/types";

/** What the alert workspace reads from GET /api/workspace/{case_id} (console/backend/routes_workspace.py). */

export interface Correction { field: string; old: unknown; new: unknown; reason: string; confidence: number | null; applied: boolean; reverted_by: string | null }
export interface Burson { filled: number; right: number; wrong: string[]; in_question: string[]; pct: number | null }
export interface Kept { kept: number; of: number; rate: number }

export interface FeedCard {
  case_id: string; status: string; source?: string; alert_name: string | null; issue_name: string | null; product: string | null; exposure_tag: string | null;
  priority: string | null; platform: string | null; track?: string | null; verdict: string | null; review_probability: number | null; burson: Burson | null;
  needs: string; waiting_min: number; engagement_total?: number | null; engagement_level?: string | null; is_kof?: boolean;
  classification: { label: string; probability?: unknown; rationale: string; trusted: boolean; decided_by: string } | null;
  field_agreement: { days: number; assessments: number; fields: Record<string, Kept> };
  citations: { ref: string; title: string; link: string; kind: string; excerpt: string }[];
  proposed_actions: { code: string; label: string; kind: string }[];
  actions_taken: { code: string; actor: string; at: string; note: string | null; escalation_id: string | null }[];
  applied_corrections: Correction[]; proposed_corrections: Correction[];
  review_reasons: string[]; post_url: string | null; author: string | null; latest_received_at: string; acknowledged_at: string | null;
  review_reasons_plain?: string[]; suppression_label?: string | null;
  sla_due_at: string | null; ts_recommended: boolean; suppression_reason: string | null;
  normalized?: Record<string, unknown>;
  issue_list?: { field: string | null; rule: string; severity: string; found: unknown; expected: unknown; fix: string | null }[];
  alert_text?: string;
  chat?: { activity_id: string; ts: string; direction: string; kind: string; space_key: string | null; actor: string; text: string; status: string; emoji: string | null }[];
}

/** An alert the agent raised on its own (a row of the feed beside Burson's alerts), or what it looked at and did not raise (passed). */
export interface AgentAlert {
  kind: "agent"; id: string; at: string; status: "raised" | "passed"; title: string; needs: string; severity: string; path: string; rationale: string; evidence: string; velocity: string;
  links: string[]; kof: string; rule: string; section: string; trigger: string; item_type: string; posted_to: string; verdict: "" | "TRUE_POSITIVE" | "FALSE_POSITIVE";
  verdict_by: string; verdict_at: string; note: string;
}

export interface FeedList { cards: FeedCard[]; total: number; agent_alerts: AgentAlert[]; agent_total: number; legend: ActionDef[]; verdicts: string[]; as_of: string }

export interface Brief {
  headline: string; saying: string; happening: string; watch: string[]; by: "gemini" | "rules"; at: string | null; stale: boolean; why_plain?: string;
  facts: { label: string; value: string }[]; next_steps: string[];
}

export interface EmailDraft {
  /** The switch "Send alert emails from the Console" is on: the composer may send the email, not only save the draft. */
  can_send?: boolean;
  status: "new" | "drafted" | "revision_requested" | "redrafted" | "sent" | "discarded" | "failed";
  subject: string; to: string[]; cc: string[]; bcc: string[]; html: string; template: string; templates: Record<string, string>;
  groups: string[]; missing: string[]; reasons: Record<string, string>; notes: string[];
  edited: boolean; saved_at: string | null; escalation_id: string | null; from: string; sent_at: string | null; error: string | null;
  gmail: { connected: boolean; url: string }; testing: { on: boolean; recipients: number }; recipients_in: string;
  others: { analyst: string; escalation_id: string; status: string; sent_at: string | null }[];
}

export interface TnsView {
  recommended: boolean; reasons: string[]; urgent_reasons: string[]; state: TnsState | null; escalation_id: string | null; by: string | null; mine: boolean;
  unverified_form: boolean; evidence_required: boolean; criteria_doc_url: string; criteria: Record<string, string>;
}

export interface TempBrief {
  check_id: string; issue: string; status: string; total: number; concern_level: string; basis: string; trigger: string; requested_by: string;
  created_at: string; title: string; doc_url: string; error: string; own_posts: number; own_from: string | null;
}
export interface TempView { enabled: boolean; auto: boolean; docs: boolean; checks: TempBrief[] }

export interface Criterion { id: string; label: string; weight: number; asks: string }
export interface Rubric { subject_type: "case" | "agent_alert"; criteria: Criterion[]; scale: { value: number; label: string }[]; pass_at: number; fail_below: number }
export interface EvalStep { kind: "golden" | "verdict" | "lesson"; status: "done" | "failed" | "skipped" | "waiting" | "held" | "applied" | "rejected"; ref: string; text: string; note?: string; decided_by?: string | null; same?: boolean }
/** Who evaluated an alert and what the person looking may do. One person evaluates an alert: the first to submit, who may revise it. */
export interface QaStanding { evaluator: string | null; eval_id: string | null; mine: boolean; can_submit: boolean }
export interface QaEval {
  id: string; subject_type: "case" | "agent_alert"; subject_id: string; case_id: string | null; title: string; evaluator: string; at: string;
  ratings: Record<string, number | null>; comment: string; corrections: { verdict?: string; fields?: Record<string, unknown> };
  score: number | null; grade: "pass" | "needs_work" | "fail" | ""; rated: number; of: number;
  comprehension: { by: "gemini" | "rules"; understood: string; lessons: string[]; why_plain?: string };
  steps: EvalStep[];
  /** How many times its owner revised it, when it was first submitted, and its earlier versions (score, ratings, words). */
  revision: number; first_at: string;
  history?: { at: string; score: number | null; grade: string; ratings: Record<string, number | null>; comment: string }[];
}

export interface Workspace {
  card: FeedCard; brief: Brief; email: EmailDraft; tns: TnsView; temp: TempView; qa: { rubric: Rubric; evals: QaEval[]; standing: QaStanding };
  events: AgentEvent[]; legend: ActionDef[]; verdicts: string[]; can_act: boolean;
}

export const GRADE: Record<string, { label: string; tone: "emerald" | "violet" | "rose" | "zinc" }> = {
  pass: { label: "Pass", tone: "emerald" }, needs_work: { label: "Needs work", tone: "violet" }, fail: { label: "Fail", tone: "rose" }, "": { label: "Not scored", tone: "zinc" },
};
export const STEP_TONE: Record<EvalStep["status"], "emerald" | "violet" | "rose" | "zinc" | "blue"> = {
  done: "emerald", applied: "emerald", waiting: "blue", held: "violet", skipped: "zinc", rejected: "zinc", failed: "rose",
};
export const STEP_WORD: Record<EvalStep["status"], string> = {
  done: "Done", applied: "In use", waiting: "Waiting for a lead", held: "Held for a lead", skipped: "Skipped", rejected: "Not in use", failed: "Failed",
};
