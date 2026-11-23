// Labels and color tokens shared by pages (Tailwind classes, light + dark).
// Colours are Google's and Gemini's only: Google blue, Gemini violet, Gemini rose (Google red), Google green and the
// Gemini neutrals. Never yellow, orange, amber, gold or lime.

/**
 * A badge's colour. Use zinc (neutral), blue (information), violet (needs a look, warnings), rose (errors, overdue) and
 * emerald (green: done, fine). The other names are kept so older call sites still work, and each draws a brand colour:
 * amber and orange draw violet, lime and teal green, pink rose, cyan and indigo blue, slate the neutral grey.
 */
export type Tone = "zinc" | "blue" | "emerald" | "amber" | "rose" | "violet" | "cyan" | "indigo" | "teal" | "orange" | "pink" | "lime" | "slate";

const NEUTRAL = "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700";
const BLUE = "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-800/60";
const VIOLET = "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:ring-violet-800/60";
const ROSE = "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:ring-rose-800/60";
const GREEN = "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800/60";

export const TONE_CLASSES: Record<Tone, string> = {
  zinc: NEUTRAL, slate: NEUTRAL, blue: BLUE, cyan: BLUE, indigo: BLUE, violet: VIOLET, rose: ROSE, pink: ROSE, emerald: GREEN, teal: GREEN, lime: GREEN,
  amber: VIOLET, orange: VIOLET,  // old names for the warning tone: drawn Gemini violet
};

/** Chart colours in order: Google blue, Google green, Gemini violet, Google red, then deeper and lighter shades of the same. */
export const CHART_COLORS = ["#4285f4", "#34a853", "#9b72cb", "#ea4335", "#0b57d0", "#d96570", "#188038", "#6c469c", "#7cacf8", "#80868b"];

// Colour says whether a case needs someone: violet waits for an IM, rose waits on Burson, green is done, grey is over.
export const STATUS_TONE: Record<string, Tone> = {
  VERIFIED: "emerald", FAILED: "rose", NEEDS_REVIEW: "violet", SUPPRESSED: "zinc", CLOSED: "zinc", ABANDONED: "zinc",
};
export const STATUS_LABEL: Record<string, string> = {
  VERIFIED: "Verified", FAILED: "Waiting on Burson", NEEDS_REVIEW: "Needs review", SUPPRESSED: "Suppressed", CLOSED: "Closed", ABANDONED: "Abandoned",
};
/** The agent's verdict on an alert, said as what its check found (the case status says where the case is now). */
export const VERDICT_TONE: Record<string, Tone> = { PASS: "emerald", CORRECTED: "blue", SUPPRESSED: "zinc", NEEDS_REVIEW: "violet", FAIL: "rose" };
export const VERDICT_LABEL: Record<string, string> = {
  PASS: "Passed", CORRECTED: "Corrected", SUPPRESSED: "Not alertable", NEEDS_REVIEW: "Held for review", FAIL: "Failed checks",
};
/** What the Review feed says a case is waiting for. */
export const NEED_LABEL: Record<string, { label: string; tone: Tone }> = {
  sla: { label: "SLA at risk", tone: "rose" }, review: { label: "Needs review", tone: "violet" },
  acknowledge: { label: "To acknowledge", tone: "blue" }, source_fix: { label: "Waiting on Burson", tone: "rose" },
};
// A verdict that only repeats the badge beside it: the status (or what the case waits for) already says it.
const SAME_AS_STATUS: Record<string, string> = { NEEDS_REVIEW: "NEEDS_REVIEW", FAILED: "FAIL", SUPPRESSED: "SUPPRESSED", VERIFIED: "PASS" };
const SAME_AS_NEED: Record<string, string> = { review: "NEEDS_REVIEW", source_fix: "FAIL" };

/** Whether the verdict badge says something the status (and the need) badge beside it does not. */
export function verdictAddsInfo(verdict: string | null | undefined, status?: string | null, need?: string | null): boolean {
  if (!verdict) return false;
  if (status && SAME_AS_STATUS[status] === verdict) return false;
  if (need && SAME_AS_NEED[need] === verdict) return false;
  return true;
}

/** "EXCLUDED_GOOGLE_AS_VERB" or "triage.needs_review" as words: the last resort when no label is written. */
export function humanize(code: string): string {
  const words = code.replace(/^EXCLUDED_/, "").replace(/[._]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : code;
}

export function statusLabel(status: string | null | undefined): string {
  return status ? STATUS_LABEL[status] ?? humanize(status) : "—";
}

export function verdictLabel(verdict: string | null | undefined): string {
  return verdict ? VERDICT_LABEL[verdict] ?? humanize(verdict) : "—";
}

export const SOURCE_LABEL: Record<string, string> = { burson_chat: "Burson chat", inhouse: "In-house", watchdog: "Watchdog email", manual: "Added by hand" };
export const TRACK_LABEL: Record<string, string> = { URGENT: "Urgent", HIGH_ENGAGEMENT: "High engagement" };

/** Why an alert was not posted, in words (the codes come from the Collection Requirements). */
export const SUPPRESSION_LABEL: Record<string, string> = {
  below_threshold: "Under 2K engagements, with no urgent reason",
  ongoing_no_kof: "Ongoing issue with no KOF",
  youtube_no_action: "YouTube post under 2K engagements: no action",
  EXCLUDED_SPAM: "Spam",
  EXCLUDED_BENCHMARK: "A benchmark comparison",
  EXCLUDED_AI_COMPARISON: "A comparison of AI products",
  EXCLUDED_GOOGLE_AS_VERB: "\"Google\" used as a verb",
  EXCLUDED_DRIVE_LINK: "A Google Drive link",
  im_review: "An IM suppressed it after review",
  unspecified: "No reason recorded",
};

export function suppressionLabel(code: string | null | undefined): string {
  return code && code !== "None" ? SUPPRESSION_LABEL[code] ?? humanize(code) : SUPPRESSION_LABEL.unspecified;
}

/**
 * A reason an alert was held for review, as a sentence: field keys as labels, codes as words. The server sends these
 * already in words (review_reasons_plain, console/backend/serializers.py plain_reason); this covers older data.
 */
export function plainReason(reason: string, fieldLabel: (key: string) => string): string {
  const text = reason.trim();
  const held = /^would be suppressed \(([^)]*)\)/i.exec(text);
  if (held) {
    const why = suppressionLabel(held[1]);
    return `Normally it would not be posted (${why[0].toLowerCase()}${why.slice(1)}), but the fields that decide that need a person to check them.`;
  }
  const proposed = /^([a-z][a-z0-9_]*): proposed "(.*)"(?: \((\d+)% likely right\))? [—-] (.*)$/s.exec(text);
  if (proposed) return `${fieldLabel(proposed[1])}: the agent suggests “${proposed[2]}”${proposed[3] ? ` (${proposed[3]}% likely right)` : ""}. ${proposed[4]}`;
  const says = /^([a-z][a-z0-9_]*): (.+)$/s.exec(text);
  if (says && (says[1] === "alert" || says[1].includes("_") || fieldLabel(says[1]) !== says[1])) {
    const rest = /^[a-z0-9_]+$/.test(says[2]) ? humanize(says[2]) : says[2];
    return says[1] === "alert" ? rest : `${fieldLabel(says[1])}: ${rest}`;
  }
  return text;
}

export const PROTOCOL_LABEL: Record<string, string> = {
  youtube: "▶️ YouTube Social", doodle: "🎨 Doodle Team", leadership: "🔔 Leadership", crisis: "🔥 Crisis chat", jon: "🧑‍💻 Jon",
};

export const ONCALL_SOURCE_TONE: Record<string, Tone> = { override: "blue", rotation: "emerald", backup: "violet", fallback: "violet", none: "rose" };

/** Where a waiting post goes, in words, and its colour. */
export const TARGET_LABEL: Record<string, string> = {
  clean: "Clean space", burson: "Burson's space", dm: "Direct message", team: "Team space", crisis: "Crisis chat", youtube: "YouTube Social",
  doodle: "Doodle team", handover: "Shift handover",
};
export const TARGET_TONE: Record<string, Tone> = {
  clean: "emerald", burson: "violet", dm: "blue", team: "blue", crisis: "rose", youtube: "rose", doodle: "blue", handover: "zinc",
};

/** Every event the agent logs, in words. Anything not listed is spelled out from its name. */
export const EVENT_LABEL: Record<string, string> = {
  "alert.received": "Alert received", "triage.passed": "Passed checks", "triage.corrected": "Corrected by the agent", "triage.suppressed": "Not alertable",
  "triage.failed": "Sent back to Burson", "triage.needs_review": "Held for review", "triage.classified": "Classified",
  "correction.applied": "Field corrected", "correction.proposed": "Correction suggested", "correction.reverted": "Correction undone",
  "review.forwarded": "Held alert sent on", "review.bounced": "Held alert sent back", "review.suppressed": "Held alert suppressed",
  "clean.posted": "Posted to the clean space", "case.updated": "Case updated", "case.closed": "Case closed", "case.abandoned": "Case abandoned",
  "oncall.notified": "On-call told", "oncall.override_set": "On-call cover set", "verdict.overridden": "Verdict marked wrong", "message.ignored": "Message set aside",
  "alert.acknowledged": "Alert acknowledged", "action.recorded": "Action taken", "sla.at_risk": "SLA at risk", "sla.met": "SLA met", "sla.missed": "SLA missed",
  "protocol.pinged": "Protocol ping", "escalation.started": "Escalation started", "email.drafted": "Email drafted", "email.group_added": "Group added to an email",
  "email.revision_requested": "Email edit asked for", "email.redrafted": "Email redrafted", "email.sent": "Email sent", "email.discarded": "Email discarded",
  "email.failed": "Email failed", "tns.assessed": "T&S assessed", "tns.not_eligible": "Not eligible for T&S", "tns.prepared": "T&S form ready",
  "tns.submitted": "T&S submitted", "tns.withdrawn": "T&S withdrawn", "tns.outcome": "T&S outcome", "watchdog.received": "Watchdog email",
  "watchdog.skipped": "Watchdog email skipped", "parity.matched": "Matched with Burson", "parity.unmatched": "No match with Burson",
  "qa.answered": "Question answered", "qa.feedback": "Answer rated", "route.forwarded": "Question passed on", "route.relayed": "Question passed on",
  "roster.updated": "Roster changed", "burson.digest_posted": "Burson digest posted", "handover.posted": "Shift handover posted", "outbox.delivered": "Posts delivered",
  "config.updated": "Settings changed", "config.change_proposed": "Settings change suggested", "config.change_approved": "Settings change approved",
  "config.change_rejected": "Settings change turned down", "knowledge.fact_proposed": "Fact suggested", "knowledge.fact_approved": "Fact approved",
  "knowledge.fact_rejected": "Fact turned down", "knowledge.doc_saved": "Document saved", "knowledge.doc_removed": "Document removed",
  "knowledge.indexed": "Documents read in", error: "Error", "audit.recorded": "Action recorded", "chat.inbound": "Chat message in", "chat.outbound": "Chat message out",
  "assessment.recorded": "IM assessment", "golden.recorded": "Example saved", "safety.blocked": "Held by a safety check", "safety.checked": "Safety check",
  "outbound.published": "Queued to send", "outbound.delivered": "Delivered", "outbound.failed": "Delivery failed", "outbound.dead_lettered": "Delivery gave up",
  "outbound.replayed": "Delivery tried again", "llm.usage": "Gemini call", "prompt.published": "AI instructions changed", "agent_chat.turn": "Chat agent reply",
  "agent_chat.tool": "Chat agent action", "temp_check.started": "Temp check started", "temp_check.completed": "Temp check done", "temp_check.failed": "Temp check failed",
  "temp_check.actioned": "Temp check action", "forecast.run": "Forecast run", "forecast.failed": "Forecast failed", "workforce.recommendation_created": "Staffing suggestion",
  "workforce.recommendation_decided": "Staffing suggestion decided", "workforce.gap_alert": "Busier than forecast", "workforce.shift_updated": "Shift changed",
  "watch.saved": "Watch saved", "watch.detected": "Watch found a post", "campaign.saved": "Campaign saved", "bigquery.changed": "BigQuery settings changed",
  "secret.changed": "Secret changed", "own.cycle": "Agent alerts run", "own.reviewed": "Agent alert reviewed", "own.raised": "Agent alert raised",
  "own.feedback": "Agent alert feedback", "own.rule_saved": "Agent alert rule saved",
};

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? humanize(type);
}

const EVENT_TONES: [string, Tone][] = [
  ["alert.received", "blue"], ["triage.passed", "emerald"], ["triage.corrected", "blue"], ["triage.suppressed", "zinc"],
  ["triage.failed", "rose"], ["triage.needs_review", "violet"], ["correction.", "blue"], ["review.", "violet"],
  ["clean.", "emerald"], ["case.", "zinc"], ["oncall.", "violet"], ["verdict.", "rose"], ["message.ignored", "zinc"],
  ["alert.acknowledged", "emerald"], ["action.", "emerald"], ["sla.met", "emerald"], ["sla.", "rose"], ["protocol.", "rose"],
  ["escalation.", "blue"], ["email.", "blue"], ["tns.", "blue"], ["watchdog.", "blue"], ["parity.", "emerald"],
  ["qa.", "emerald"], ["route.", "emerald"], ["roster.", "violet"], ["burson.", "zinc"], ["handover.", "zinc"],
  ["outbox.", "zinc"], ["config.", "violet"], ["knowledge.", "violet"], ["error", "rose"],
];

export function eventTone(type: string): Tone {
  return EVENT_TONES.find(([prefix]) => type === prefix || type.startsWith(prefix))?.[1] ?? "zinc";
}

export const EVENT_GROUPS: { label: string; value: string }[] = [
  { label: "All events", value: "" },
  { label: "Intake & triage", value: "alert.,triage.,message.ignored" },
  { label: "Corrections", value: "correction." },
  { label: "Reviews", value: "review." },
  { label: "Cases & on-call", value: "case.,oncall.,clean.,verdict." },
  { label: "IM actions & SLA", value: "alert.acknowledged,action.,sla.,protocol." },
  { label: "Emails", value: "escalation.,email." },
  { label: "Trust & Safety", value: "tns.,watchdog." },
  { label: "Our alerts vs Burson's", value: "parity." },
  { label: "Conversation", value: "qa.,route." },
  { label: "Jobs & waiting posts", value: "burson.,handover.,outbox." },
  { label: "Settings, rosters & learning", value: "config.,knowledge.,roster.,oncall.override_set" },
  { label: "Errors", value: "error" },
];

/** Gmail permissions in plain words, keyed by the short scope name the OAuth callback reports. */
export const GMAIL_SCOPE_LABEL: Record<string, string> = {
  compose: "create and update drafts in your Gmail",
  metadata: "see whether a draft was sent (message headers only, never the content)",
  readonly: "read your mail to see whether a draft was sent",
  send: "send email from this account",
  modify: "update messages and labels",
  full: "full access to the mailbox",
};

/** Message after Google returned fewer Gmail permissions than requested (unticked on the consent screen). */
export function gmailMissingScopesMessage(missing: string[], mailbox: string | null): string {
  const words = missing.map((s) => GMAIL_SCOPE_LABEL[s] ?? s);
  const ask = mailbox === "agent"
    ? "Please allow all requested Gmail permissions (send email for the doorbell) and connect again."
    : "Please allow all requested Gmail permissions (drafts + send status) and connect again.";
  return words.length ? `${ask} Missing: ${words.join("; ")}.` : ask;
}
