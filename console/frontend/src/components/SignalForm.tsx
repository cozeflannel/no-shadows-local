import { useEffect, useState } from "react";

import { apiSend, type ApiError } from "../api/client";
import { useApp } from "../context";
import { Alert, Button, ErrorState, Field, Input, Modal, Select, Textarea, Toggle } from "./ui";

// The New signal / Edit signal form: one signal (a watch) as on the sheet's Watches tab, with one line of help per field.

export interface Signal { watch_id: string; name: string; enabled: boolean; question: string; rubric: string; topics: string[]; flag_at_score: number | null; networks: string[]; status: string; imported_from?: string; sheet_on?: boolean; updated_by: string; updated_at: string | null; checked?: boolean; flagged_24h?: number; near_misses_24h?: number; plain_status?: string }
export interface SignalTemplate { key: string; name: string; question: string; rubric: string; topics: string[]; flag_at_score: number | null; networks: string[] }
export interface SignalDefaults { rubric: string; topics: string[]; flag_at_score: number }

interface Form { watch_id: string; name: string; enabled: boolean; question: string; rubric: string; topics: string; flag_at_score: string; networks: string }

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const NETWORK_NAMES: Record<string, string> = { x: "X", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", reddit: "Reddit", bluesky: "Bluesky", facebook: "Facebook", threads: "Threads", linkedin: "LinkedIn" };
export const networkName = (n: string) => NETWORK_NAMES[n] ?? n;

function fromSignal(s: Pick<Signal, "name" | "question" | "rubric" | "topics" | "flag_at_score" | "networks">, extra: Partial<Form> = {}): Form {
  return { watch_id: "", enabled: false, name: s.name, question: s.question, rubric: s.rubric, topics: s.topics.join(", "),
    flag_at_score: s.flag_at_score === null ? "" : String(s.flag_at_score), networks: s.networks.map(networkName).join(", "), ...extra };
}

/** Add a signal (from the sheet's defaults, one of its templates, or a copy of another signal) or change one. */
export function SignalForm({ open, signal, signals, defaults, templates, maxOn, switchOn, onClose, onSaved }: {
  open: boolean; signal: Signal | null; signals: Signal[]; defaults: SignalDefaults; templates: SignalTemplate[]; maxOn: number; switchOn: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useApp();
  const blank: Form = { watch_id: "", name: "", enabled: false, question: "", rubric: defaults.rubric, topics: defaults.topics.join(", "), flag_at_score: String(defaults.flag_at_score), networks: "" };
  const [form, setForm] = useState<Form>(blank);
  const [start, setStart] = useState("defaults");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null); setStart("defaults");
    setForm(signal ? fromSignal(signal, { watch_id: signal.watch_id, enabled: signal.enabled }) : blank);
  }, [open, signal]);  // eslint-disable-line -- `blank` is rebuilt each render from the same defaults
  const startFrom = (key: string) => {
    setStart(key);
    const t = templates.find((x) => `t:${x.key}` === key);
    const s = signals.find((x) => `s:${x.watch_id}` === key);
    setForm(t ? fromSignal(t) : s ? fromSignal(s, { name: `${s.name} (copy)` }) : blank);
  };
  const onNow = signals.filter((s) => s.enabled && s.watch_id !== form.watch_id).length;
  const atLimit = !form.enabled && onNow >= maxOn;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await apiSend("post", "/watches", { watch_id: form.watch_id || undefined, name: form.name.trim(), enabled: form.enabled, question: form.question.trim(),
        rubric: form.rubric.trim(), topics: list(form.topics), networks: list(form.networks), flag_at_score: form.flag_at_score.trim() ? Number(form.flag_at_score) : null });
      toast(form.watch_id ? "Signal saved" : form.enabled ? "Signal added and turned on" : "Signal added (off)");
      onSaved(); onClose();
    } catch (err) { setError(err as ApiError); } finally { setBusy(false); }
  };
  const score = form.flag_at_score.trim() ? Number(form.flag_at_score) : NaN;
  const badScore = form.flag_at_score.trim() !== "" && !(score >= 1 && score <= 10);
  return (
    <Modal open={open} wide title={form.watch_id ? "Edit signal" : "New signal"} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.name.trim() || !form.question.trim() || badScore} onClick={() => void save()}>{form.watch_id ? "Save" : "Add signal"}</Button></>}>
      <div className="space-y-3">
        <ErrorState error={error} />
        {!form.watch_id && (
          <Field label="Start from (fills the form in: change anything before you save)">
            <Select value={start} onChange={(e) => startFrom(e.target.value)}>
              <option value="defaults">A blank signal with the sheet's standard scoring and topics</option>
              <optgroup label="The sheet's templates">{templates.map((t) => <option key={t.key} value={`t:${t.key}`}>{t.name}</option>)}</optgroup>
              {signals.length > 0 && <optgroup label="A copy of a signal you have">{signals.map((s) => <option key={s.watch_id} value={`s:${s.watch_id}`}>{s.name}</option>)}</optgroup>}
            </Select>
          </Field>
        )}
        <Field label="Name" hint="A short name people will recognise, such as “Midterms 2026 × Google”.">
          <Input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="What to look for" hint="A yes/no question Gemini asks of every new post. Say what counts, and what doesn't.">
          <Textarea rows={3} className="font-sans text-sm" maxLength={2000} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} />
        </Field>
        <Field label="How to score impact (1 to 10)" hint="From 1 (harmless) to 10 (about to be everywhere). The sheet's standard wording is filled in.">
          <Textarea rows={3} className="font-sans text-sm" maxLength={2000} value={form.rubric} onChange={(e) => setForm({ ...form, rubric: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_9rem]">
          <Field label="Topics" hint="Comma separated. Each flagged post is put under one of these (or Other).">
            <Textarea rows={2} className="font-sans text-sm" value={form.topics} onChange={(e) => setForm({ ...form, topics: e.target.value })} />
          </Field>
          <Field label="Flag at score" error={badScore ? "A number from 1 to 10." : null} hint={`Flagged at this score or more. Standard: ${defaults.flag_at_score}.`}>
            <Input type="number" min={1} max={10} step="0.5" value={form.flag_at_score} onChange={(e) => setForm({ ...form, flag_at_score: e.target.value })} />
          </Field>
        </div>
        <Field label="Networks" hint="Comma separated, such as X, TikTok, Reddit. Leave it empty for every network.">
          <Input value={form.networks} onChange={(e) => setForm({ ...form, networks: e.target.value })} />
        </Field>
        <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-950">
          <Toggle label="On: check new posts for this signal" checked={form.enabled} disabled={atLimit} onChange={(v) => setForm({ ...form, enabled: v })} />
          <p className="mt-1 text-xs text-zinc-500">
            {atLimit ? `${onNow} of ${maxOn} signals are on, the most at once: turn one off first.` : `${onNow} of ${maxOn} signals are on now. At most ${maxOn} can be on at once, because each one is a question Gemini asks of every new post.`}
          </p>
        </div>
        {!switchOn && form.enabled && <Alert tone="blue">The Watches switch is off, so nothing is checked yet, even for signals that are on. You can still save it.</Alert>}
      </div>
    </Modal>
  );
}
