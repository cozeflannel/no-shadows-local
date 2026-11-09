// Labels and color tokens shared by pages (Tailwind classes, light + dark).

export type Tone = "zinc" | "blue" | "emerald" | "amber" | "rose" | "violet" | "cyan" | "indigo" | "teal" | "orange" | "pink" | "lime" | "slate";

export const TONE_CLASSES: Record<Tone, string> = {
  zinc: "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700",
  slate: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800/70 dark:text-slate-300 dark:ring-slate-700",
  blue: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-800/60",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800/60",
  amber: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800/60",
  rose: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:ring-rose-800/60",
  violet: "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:ring-violet-800/60",
  cyan: "bg-cyan-50 text-cyan-800 ring-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-300 dark:ring-cyan-800/60",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:ring-indigo-800/60",
  teal: "bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:ring-teal-800/60",
  orange: "bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:ring-orange-800/60",
  pink: "bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-900/30 dark:text-pink-300 dark:ring-pink-800/60",
  lime: "bg-lime-50 text-lime-800 ring-lime-200 dark:bg-lime-900/30 dark:text-lime-300 dark:ring-lime-800/60",
};

export const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];

export const STATUS_TONE: Record<string, Tone> = {
  VERIFIED: "emerald", FAILED: "rose", NEEDS_REVIEW: "amber", SUPPRESSED: "zinc", CLOSED: "slate", ABANDONED: "orange",
};
export const STATUS_LABEL: Record<string, string> = {
  VERIFIED: "Verified", FAILED: "Needs Burson", NEEDS_REVIEW: "Needs review", SUPPRESSED: "Suppressed", CLOSED: "Closed", ABANDONED: "Abandoned",
};
export const VERDICT_TONE: Record<string, Tone> = { PASS: "emerald", CORRECTED: "blue", SUPPRESSED: "zinc", NEEDS_REVIEW: "amber", FAIL: "rose" };

export const SOURCE_LABEL: Record<string, string> = { burson_chat: "Burson chat", inhouse: "In-house", watchdog: "Watchdog", manual: "Manual" };
export const TRACK_LABEL: Record<string, string> = { URGENT: "Urgent", HIGH_ENGAGEMENT: "High engagement" };

export const SUPPRESSION_LABEL: Record<string, string> = {
  below_threshold: "Below threshold (no URGENT reason, under 2K)",
  ongoing_no_kof: "Ongoing issue, no KOF",
  youtube_no_action: "YouTube subject under 2K (no action)",
  EXCLUDED_SPAM: "Spam",
  EXCLUDED_BENCHMARK: "Benchmark comparison",
  EXCLUDED_AI_COMPARISON: "AI product comparison",
  EXCLUDED_GOOGLE_AS_VERB: "Google as a verb",
  EXCLUDED_DRIVE_LINK: "Drive link",
  im_review: "IM decided after review",
  unspecified: "Unspecified",
};

export const PROTOCOL_LABEL: Record<string, string> = {
  youtube: "▶️ YouTube Social", doodle: "🎨 Doodle Team", leadership: "🔔 Leadership", crisis: "🔥 Crisis chat", jon: "🧑‍💻 Jon",
};

export const ONCALL_SOURCE_TONE: Record<string, Tone> = { override: "violet", rotation: "emerald", backup: "amber", fallback: "orange", none: "rose" };

export const TARGET_TONE: Record<string, Tone> = {
  clean: "emerald", burson: "orange", dm: "blue", team: "violet", crisis: "rose", youtube: "pink", doodle: "lime", handover: "slate",
};

const EVENT_TONES: [string, Tone][] = [
  ["alert.received", "blue"], ["triage.passed", "emerald"], ["triage.corrected", "blue"], ["triage.suppressed", "zinc"],
  ["triage.failed", "rose"], ["triage.needs_review", "amber"], ["correction.", "violet"], ["review.", "amber"],
  ["clean.", "emerald"], ["case.", "slate"], ["oncall.", "orange"], ["verdict.", "rose"], ["message.ignored", "zinc"],
  ["alert.acknowledged", "emerald"], ["action.", "teal"], ["sla.met", "emerald"], ["sla.", "rose"], ["protocol.", "pink"],
  ["escalation.", "cyan"], ["email.", "cyan"], ["tns.", "indigo"], ["watchdog.", "indigo"], ["parity.", "teal"],
  ["qa.", "lime"], ["route.", "lime"], ["roster.", "orange"], ["burson.", "slate"], ["handover.", "slate"],
  ["outbox.", "slate"], ["config.", "violet"], ["knowledge.", "violet"], ["error", "rose"],
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
  { label: "Parity", value: "parity." },
  { label: "Conversation", value: "qa.,route." },
  { label: "Jobs & outbox", value: "burson.,handover.,outbox." },
  { label: "Config, rosters & learning", value: "config.,knowledge.,roster.,oncall.override_set" },
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
