import { useEffect, useState } from "react";

import type { Json } from "../../api/types";
import { Field, Input, Select, Textarea, Toggle } from "../ui";

type FieldDef =
  | { key: string; label: string; help?: string; type: "number"; min?: number; max?: number; step?: number; integer?: boolean }
  | { key: string; label: string; help?: string; type: "boolean" }
  | { key: string; label: string; help?: string; type: "text"; nullable?: boolean; placeholder?: string }
  | { key: string; label: string; help?: string; type: "select"; options: string[] }
  | { key: string; label: string; help?: string; type: "list"; placeholder?: string };

export const STRUCTURED_SCHEMAS: Record<string, FieldDef[]> = {
  thresholds: [
    { key: "needs_review_below", label: "Hold for review below confidence", type: "number", min: 0, max: 1, step: 0.01, help: "Overall confidence under this sends the alert to the IM on shift." },
    { key: "llm_block_min_confidence", label: "Gemini blocking-finding confidence", type: "number", min: 0, max: 1, step: 0.01, help: "A blocking Gemini finding below this confidence goes to review instead of Burson." },
    { key: "llm_checks_enabled", label: "Run the Gemini assessment", type: "boolean" },
    { key: "url_check_enabled", label: "Check that post URLs are reachable", type: "boolean" },
    { key: "url_check_timeout_s", label: "URL check timeout (s)", type: "number", min: 0.5, max: 30, step: 0.5 },
    { key: "max_correction_wait_min", label: "Abandon bounced alerts after (min)", type: "number", min: 15, step: 5, integer: true },
    { key: "sla_warn_fraction", label: "SLA nudge at fraction of SLA", type: "number", min: 0.1, max: 1, step: 0.05, help: "DM the IM when this share of the SLA has passed unacknowledged." },
    { key: "review_reminder_min", label: "Review reminder after (min)", type: "number", min: 1, step: 1, integer: true },
  ],
  corrections: [
    { key: "mode", label: "Mode", type: "select", options: ["auto", "propose"], help: "auto: apply high-confidence fixes (IMs can revert). propose: always ask the IM." },
    { key: "auto_apply_min_confidence", label: "Auto-apply at confidence ≥", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "never_auto_correct", label: "Never auto-correct these fields", type: "list", placeholder: "post_url", help: "Comma- or line-separated field names; these bounce to Burson instead." },
  ],
  burson_feedback: [
    { key: "mode", label: "Mode", type: "select", options: ["digest", "realtime", "off"], help: "How Burson hears about the corrections the agent made." },
    { key: "digest_hour_local", label: "Digest hour (display timezone)", type: "number", min: 0, max: 23, step: 1, integer: true },
    { key: "recipients", label: "Burson leads to mention", type: "list", placeholder: "lead@agency.test" },
    { key: "post_digest_to_burson_space", label: "Post the digest in the Burson space", type: "boolean" },
  ],
  outbox: [
    { key: "doorbell", label: "How Chat is told a post is waiting", type: "select", options: ["sheet", "email", "none"], help: "A row in a sheet, an email, or none (the Chat flow checks on its own schedule)." },
    { key: "sheet_id", label: "Agent Outbox Sheet id", type: "text", nullable: true, placeholder: "1AbC…" },
    { key: "sheet_tab", label: "Sheet tab", type: "text" },
    { key: "email_subject", label: "Subject of the email that tells Chat", type: "text" },
    { key: "clean_items_per_drain", label: "Clean-space items per drain", type: "number", min: 1, max: 10, step: 1, integer: true, help: "Keep at 1 so each alert is its own message (reactions map to one case)." },
    { key: "max_items_per_target", label: "Max items per other target", type: "number", min: 1, max: 50, step: 1, integer: true },
  ],
  handover: [
    { key: "enabled", label: "Post shift handovers", type: "boolean" },
    { key: "post_to_team", label: "Post to the 24/7 SL team chat", type: "boolean" },
    { key: "append_to_doc", label: "Append to the Handover doc", type: "boolean" },
    { key: "minutes_after_shift_end", label: "Minutes after shift end", type: "number", min: 0, max: 120, step: 1, integer: true },
  ],
  metrics: [
    { key: "burson_retrigger_minutes", label: "Burson correction + retrigger (min)", type: "number", min: 0, step: 1, integer: true, help: "Median wait avoided per auto-fixed alert (time-saved KPI)." },
    { key: "im_minutes_per_alert", label: "IM minutes per drafted alert", type: "number", min: 0, step: 1, integer: true, help: "Manual Alert Assistant + email work replaced per draft." },
  ],
  models: [
    { key: "triage", label: "Triage model", type: "text" },
    { key: "drafting", label: "Drafting model", type: "text" },
    { key: "converse", label: "Conversation model", type: "text" },
    { key: "location", label: "Vertex AI location", type: "text" },
    { key: "temperature_triage", label: "Triage temperature", type: "number", min: 0, max: 2, step: 0.1 },
    { key: "temperature_drafting", label: "Drafting temperature", type: "number", min: 0, max: 2, step: 0.1 },
  ],
};

export function toList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

/** Comma/line separated list input that keeps the raw text while typing. */
export function ListInput({ value, onChange, placeholder, disabled, rows = 3, className }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean; rows?: number; className?: string;
}) {
  const [text, setText] = useState(value.join("\n"));
  const joined = value.join("\n");
  useEffect(() => {
    setText((current) => (toList(current).join("\n") === joined ? current : joined));
  }, [joined]);
  return (
    <Textarea rows={rows} value={text} placeholder={placeholder} disabled={disabled} className={className ?? "font-sans text-sm"}
      onChange={(e) => { setText(e.target.value); onChange(toList(e.target.value)); }} />
  );
}

export function StructuredEditor({ section, value, onChange, fieldErrors, disabled }: {
  section: string; value: Record<string, Json>; onChange: (v: Record<string, Json>) => void; fieldErrors: Record<string, string>; disabled?: boolean;
}) {
  const schema = STRUCTURED_SCHEMAS[section] ?? [];
  const set = (key: string, v: Json) => onChange({ ...value, [key]: v });
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
      {schema.map((f) => {
        const v = value[f.key];
        const error = fieldErrors[f.key];
        if (f.type === "boolean") {
          return (
            <div key={f.key}>
              <Toggle checked={Boolean(v)} onChange={(x) => set(f.key, x)} label={f.label} disabled={disabled} />
              {f.help && <p className="ml-6 mt-1 text-xs text-zinc-400">{f.help}</p>}
              {error && <p className="ml-6 mt-1 text-xs text-rose-600">{error}</p>}
            </div>
          );
        }
        return (
          <Field key={f.key} label={f.label} hint={f.help} error={error}>
            {f.type === "number" ? (
              <Input type="number" value={v === null || v === undefined ? "" : String(v)} min={f.min} max={f.max} step={f.step} disabled={disabled}
                onChange={(e) => set(f.key, e.target.value === "" ? null : f.integer ? parseInt(e.target.value, 10) : Number(e.target.value))} />
            ) : f.type === "select" ? (
              <Select value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} disabled={disabled}>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            ) : f.type === "list" ? (
              <ListInput value={Array.isArray(v) ? v.map(String) : []} placeholder={f.placeholder} disabled={disabled} onChange={(list) => set(f.key, list)} />
            ) : (
              <Input value={v === null || v === undefined ? "" : String(v)} placeholder={f.placeholder} disabled={disabled}
                onChange={(e) => set(f.key, f.nullable && e.target.value.trim() === "" ? null : e.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}
