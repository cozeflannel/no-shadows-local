// JSON shapes returned by console/backend (docs/CONTRACTS.md §17). Datetimes are ISO strings.

export type CaseStatus = "VERIFIED" | "FAILED" | "NEEDS_REVIEW" | "SUPPRESSED" | "CLOSED" | "ABANDONED";
export type Role = "admin" | "lead" | "analyst" | "viewer" | "none";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Me {
  email: string;
  name: string | null;
  role: Role;
  role_source: string;
  via: string;
  can_view: boolean;
  can_act: boolean;
  is_lead: boolean;
  is_admin: boolean;
  env: string;
  config_version: string;
  timezone: string;
  agent: { display_name: string; email: string; message_prefix: string };
  dev_mode: boolean;
  flags: Record<string, boolean>;
}

export interface KpiDefinition { key: string; label: string; description: string; group: string }
export interface KpiGroup { key: string; label: string; description: string }
export interface ActionDef { emoji: string; code: string; label: string; kind: string; group?: string | null; target?: string | null; recipients: string[] }
export interface FieldMeta { name: string; label: string; type: string; allowed: string[] | null; correctable: boolean; required: boolean; description: string }

export interface Meta {
  env: string;
  timezone: string;
  case_id_prefix: string;
  escalation_id_prefix: string;
  event_types: string[];
  statuses: CaseStatus[];
  sources: string[];
  tracks: string[];
  priorities: string[];
  kpi_groups: KpiGroup[];
  kpi_definitions: KpiDefinition[];
  actions: ActionDef[];
  fields: FieldMeta[];
  field_labels: Record<string, string>;
  exposure_tags: { name: string; priority: string; category: string | null }[];
  sensitive_topics: string[];
  products: string[];
  platform_tiers: { name: string; platforms: string[]; sla_minutes: number | null }[];
  operations: string[];
  rosters: { name: string; label: string; description: string }[];
  kpi_count: number;
  notifications: { enabled: boolean; event_types: string[]; sources: string[]; seconds: number; max_on_screen: number };
}

export interface Window { days: number; since: string; until: string; env?: string | null }
export interface MinuteStat { avg: number | null; median: number | null; n: number }
export interface SlaRow { met: number; missed: number; pct: number | null }

export interface Derived {
  first_pass_yield: number | null;
  burson_bounce_rate: number | null;
  auto_fix_rate: number | null;
  revisions_per_email: number | null;
  sla_met_pct: number | null;
  sla_by_track: Record<string, SlaRow>;
  sla_by_tier: Record<string, SlaRow>;
  corrections_by_field: Record<string, number>;
  suppressed_by_reason: Record<string, number>;
  actions_by_code: Record<string, number>;
  protocol_pings_by_type: Record<string, number>;
  alerts_by_source: Record<string, number>;
  parity_recall: number | null;
  detect_latency_min: MinuteStat;
  post_to_send_min: MinuteStat;
  flag_to_send_min: MinuteStat;
  time_to_correction_min: MinuteStat;
  triage_latency_ms: { avg: number | null; p50: number | null };
  time_saved_hours?: number;
}

export interface KpiResponse {
  window: Window;
  kpis: Record<string, number>;
  derived: Derived;
  previous: { kpis: Record<string, number>; derived: Derived; event_count: number };
  definitions: KpiDefinition[];
  groups: KpiGroup[];
  event_count: number;
  metrics_config: { burson_retrigger_minutes: number; im_minutes_per_alert: number };
}

export type TimeseriesRow = { bucket: string } & Record<string, number | string>;
export interface TimeseriesResponse { window: Window; bucket: string; timezone: string; types: string[]; rows: TimeseriesRow[] }
export interface ErrorsResponse { window: Window; rule_codes: { code: string; count: number }[]; operation_errors: { op: string; count: number }[] }
export interface FailuresByOncallResponse { window: Window; rows: { oncall_email: string; count: number }[] }

export interface AgentEvent {
  event_id: string;
  event_ts: string;
  event_type: string;
  env: string;
  case_id: string | null;
  escalation_id: string | null;
  actor: string;
  space: string | null;
  message_ref: string | null;
  attempt: number | null;
  verdict: string | null;
  error_codes: string[];
  latency_ms: number | null;
  model: string | null;
  prompt_version: string | null;
  config_version: string | null;
  payload: Record<string, Json>;
  summary: string;
}

export interface CaseSummary {
  case_id: string;
  status: CaseStatus;
  source: string;
  source_ref: string | null;
  record_key: string | null;
  alert_name: string | null;
  product: string | null;
  exposure_tag: string | null;
  priority: string | null;
  track: string | null;
  platform: string | null;
  issue_name: string | null;
  issue_status: string | null;
  verdict: string | null;
  confidence: number | null;
  attempts: number;
  corrections: number;
  proposed: number;
  reverted: number;
  issues: number;
  blocking: number;
  engagement_total: number | null;
  engagement_level: string | null;
  sensitive_topics: string[];
  is_kof: boolean;
  alert_action: string | null;
  suppression_reason: string | null;
  reason_codes: string[];
  review_reasons: string[];
  post_url: string | null;
  author: string | null;
  received_at: string;
  latest_received_at: string;
  created_at: string;
  updated_at: string;
  sla_due_at: string | null;
  sla_met: boolean | null;
  acknowledged_at: string | null;
  clean_posted_at: string | null;
  counterpart_case_id: string | null;
  superseded_by: string | null;
  escalation_ids: string[];
  current_oncall_email: string | null;
  closed_reason: string | null;
  review: { decided_by: string; decision: string; reason: string | null; at: string } | null;
  actions: number;
  verdict_overridden_by: string | null;
  missing?: boolean;
}

export interface Correction { field: string; old: Json; new: Json; reason: string; confidence: number; source: string; applied: boolean; reverted_by: string | null }
export interface Issue { field: string | null; rule: string; severity: "blocking" | "warning"; found: string | null; expected: string | null; fix: string | null; source: string; confidence: number }
export interface RecipientPlan { to: string[]; cc: string[]; groups: string[]; reasons: Record<string, string>; missing: string[]; notes: string[] }

export interface Assessment {
  track: string | null;
  alert_action: string | null;
  reason_codes: string[];
  issue_status: string | null;
  issue_name: string | null;
  issue_fingerprint: string | null;
  related_case_id: string | null;
  priority: string | null;
  exposure_tag: string | null;
  product: string | null;
  sensitive_topics: string[];
  briefed_topics: string[];
  is_kof: boolean;
  kof_lists: string[];
  engagement_total: number | null;
  engagement_level: string | null;
  platform: string | null;
  platform_tier: string | null;
  sla_minutes: number | null;
  sla_due_at: string | null;
  alertable: boolean;
  suppression_reason: string | null;
  sundar_mention: boolean;
  non_us_markets: string[];
  secondary_products: string[];
  owned_post: boolean;
  video_timestamp: string | null;
  video_timestamp_needed: boolean;
  youtube_subject: boolean;
  youtube_protocol: string;
  bias_allegation: boolean;
  doodle_protocol: boolean;
  leadership_protocol: boolean;
  ts_recommended: boolean;
  ts_reasons: string[];
  suggested_actions: string[];
  recipients: RecipientPlan | null;
}

export interface TriageResult {
  verdict: string;
  confidence: number;
  issues: Issue[];
  corrections: Correction[];
  assessment: Assessment | null;
  record_key: string | null;
  normalized: Record<string, Json>;
  checks_run: string[];
  review_reasons: string[];
  model: string | null;
  rules_version: string | null;
  latency_ms: number;
}

export interface ChatMessage {
  message_id: string | null;
  text: string;
  sender: { name: string | null; email: string | null; type: string };
  space_id: string | null;
  space_name: string | null;
  thread_id: string | null;
  link: string | null;
  create_time: string | null;
}

export interface Attempt { attempt: number; message: ChatMessage; received_at: string; result: TriageResult }
export interface ActionRecord { code: string; emoji: string; actor: string; at: string; escalation_id: string | null; note: string | null }

export interface Case {
  case_id: string;
  record_key: string | null;
  source: string;
  source_ref: string | null;
  status: CaseStatus;
  alert_name: string | null;
  attempts: Attempt[];
  oncall_notices: { kind: string; to_email: string | null; at: string }[];
  current_oncall_email: string | null;
  clean_posted_at: string | null;
  clean_message_ref: string | null;
  acknowledged_at: string | null;
  sla_due_at: string | null;
  sla_met: boolean | null;
  review: { decided_by: string; decision: string; reason: string | null; at: string } | null;
  actions: ActionRecord[];
  escalation_ids: string[];
  alert_email_message_ids: string[];
  superseded_by: string | null;
  counterpart_case_id: string | null;
  leadership_pinged_at: string | null;
  closed_reason: string | null;
  verdict_overridden_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftVersion { version: number; subject: string; to: string[]; cc: string[]; bcc?: string[]; body: string; instruction: string | null; created_at: string }
export interface EmailState {
  purpose: string;
  status: string;
  from_alias: string | null;
  groups: string[];
  draft_id: string | null;
  thread_id: string | null;
  rfc822_message_id: string | null;
  in_reply_to: string | null;
  versions: DraftVersion[];
  revision_requests: number;
  drafted_at: string | null;
  sent_at: string | null;
  error: string | null;
}
export interface TnsState {
  status: string;
  eligible: boolean;
  urgent: boolean;
  category: string | null;
  rationale: string;
  criteria_ids: string[];
  evidence: string | null;
  fields: Record<string, string>;
  prefill_url: string | null;
  prepared_at: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  wd_issue_id: string | null;
  outcome: string | null;
  outcome_at: string | null;
  bug_id: string | null;
  bug_followup_sent_at: string | null;
}
export interface Escalation {
  escalation_id: string;
  case_id: string;
  analyst_email: string;
  requested_at: string;
  requested_by: string | null;
  trigger: string;
  emails: EmailState[];
  tns: TnsState | null;
  updated_at: string;
  is_open: boolean;
  alert_name: string | null;
  case_status: CaseStatus | null;
  track: string | null;
  product: string | null;
}

export interface CaseDetail {
  case: Case;
  summary: CaseSummary;
  events: AgentEvent[];
  escalations: Escalation[];
  counterpart: CaseSummary | null;
  related: CaseSummary | null;
  superseded_by_case: CaseSummary | null;
  revertible_fields: string[];
  can_close: boolean;
  operations: Record<string, boolean>;
}

export interface ReviewItem extends CaseSummary {
  proposed_corrections?: Correction[];
  applied_corrections?: Correction[];
  issue_list?: Issue[];
  normalized?: Record<string, Json>;
  waiting_min?: number;
}

export interface Person { id: string; name: string; email: string; org: string }
export interface OnCallResolution { person: Person | null; source: string; until: string | null }
export interface Segment { start: string; end: string; person_id: string | null; name: string | null; email: string | null; source: string; gap?: boolean }
export interface RotationSlot { person_id: string; days: string[]; start: string; end: string; tz: string }
export interface Override { override_id: string; person_id: string; start: string; end: string; reason: string | null; set_by: string; set_via: string; created_at: string }
export interface ReminderPolicy { reping_after_min: number; backup_after_min: number; notify_analyst_after_min: number; max_reminders: number }
export interface Roster {
  people: Person[];
  rotation: RotationSlot[];
  overrides: Override[];
  backup_person_id: string | null;
  fallback: Person | null;
  reminders: ReminderPolicy;
  updated_at: string | null;
  updated_by: string | null;
}
export interface RosterView {
  name: string;
  label: string;
  description: string;
  roster: Roster;
  on_call_now: OnCallResolution;
  next: Segment | null;
  escalation_chain: Person[];
  timezone: string;
  weekdays: string[];
}
export interface ScheduleBlock extends Segment { start_min: number; end_min: number }
export interface ScheduleView {
  name: string;
  timezone: string;
  start: string;
  end: string;
  now: string;
  step_minutes: number;
  segments: Segment[];
  gaps: { start: string; end: string; source: string; name: string | null }[];
  gap_minutes: number;
  days: { date: string; weekday: string; minutes: number; blocks: ScheduleBlock[] }[];
  people: Person[];
}
export interface OnCallNow { now: string; timezone: string; rosters: Record<string, OnCallResolution & { label: string; next: Segment | null }> }

export interface ParityPair { matched_at: string; burson: CaseSummary | null; inhouse: CaseSummary | null; case_ids: string[]; diffs: { field: string; burson: Json; inhouse: Json }[] }
export interface ParityUnmatched { reconciled_at: string; side: string; case: CaseSummary }
export interface ParityResponse {
  window: Window;
  summary: { matched: number; burson_only: number; inhouse_only: number; pending: number; recall: number | null; precision: number | null; full_agreement: number | null };
  field_disagreements: { field: string; count: number; rate: number | null; examples: { field: string; burson: Json; inhouse: Json; burson_case_id: string | null; inhouse_case_id: string | null }[] }[];
  matched: ParityPair[];
  burson_only: ParityUnmatched[];
  inhouse_only: ParityUnmatched[];
  pending: CaseSummary[];
  match_window_hours: number;
}

export interface SuppressedRow extends CaseSummary { reason: string; suppressed_by: string; review_reason: string | null }
export interface SuppressedResponse {
  window: Window;
  cases: SuppressedRow[];
  reasons: { reason: string; count: number }[];
  event_reasons: { reason: string; count: number }[];
  review_suppressed: number;
}

export interface OutboxItem {
  outbox_id: string;
  target: string;
  text: string;
  recipients: string[];
  case_id: string | null;
  escalation_id: string | null;
  source: string;
  created_at: string;
  delivered_at: string | null;
  delivered_by: string | null;
  stale: boolean;
  delivery_s: number | null;
}
export interface OutboxResponse { items: OutboxItem[]; count: number; undelivered: number; stale: number; doorbell: string }

export interface SettingsSection { key: string; label: string; description: string; kind: "structured" | "table" | "json"; overridden: boolean }
export interface SettingsResponse {
  config: Record<string, Json>;
  overrides: Record<string, Json>;
  sections: SettingsSection[];
  config_version: string;
  version: string;
  env: string;
  last_update: { updated_by: string; updated_at: string; note: string } | null;
  can_edit: boolean;
}
export interface SettingsHistoryEntry { updated_at: string; updated_by: string; note: string; sections_changed: string[]; changes: Record<string, { before: Json; after: Json }> }
export interface SaveSectionResponse { ok: boolean; section: string; value: Json; overridden: boolean; config_version: string }

export interface Proposal {
  proposal_id: string;
  proposed_by: string;
  via: string;
  summary: string;
  patch: Record<string, Json>;
  status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  sections: string[];
  preview: { valid: boolean; errors: { loc: (string | number)[]; msg: string }[] } | null;
}
export interface Fact { fact_id: string; text: string; source: string; status: "PENDING" | "APPROVED" | "REJECTED"; created_by: string; created_at: string; decided_by: string | null; decided_at: string | null }

export interface GmailStatus {
  available: boolean;
  connected: boolean;
  email: string;
  mode: string;
  /** "agent" = the Triage Agent account (email doorbell, gmail.send); "im" = an IM's drafting mailbox. */
  mailbox?: "agent" | "im";
  /** Gmail permissions requested for this mailbox, short names (compose, metadata | readonly, send). */
  scopes?: string[];
  /** The stored token predates a scope change (e.g. metadata -> readonly): connect again. */
  needs_reconnect?: boolean;
  missing_scopes?: string[];
  oauth_configured: boolean;
  can_connect: boolean;
  message: string;
}

export interface OpResult { ok: boolean; op: string; summary: string; case_id: string | null; reply_text: string; queued_outbox_ids: string[]; case?: CaseSummary | null }
