import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";

import { apiSend } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { Alert, Badge, Button, Spinner, Textarea } from "./ui";

interface Entry { at: string; what: string; who: string }
interface Note { id: string; by: string; at: string; text: string }
interface Incident {
  id: string; opened_at: string; opened_by: string; notes: Note[]; can_note: boolean;
  sections: { title: string; entries: Entry[] }[];
  facts: { name: string; case_id: string; product: string; priority: string; status: "open" | "closed"; alert_status: string; started_at: string;
    ended_at: string | null; minutes: number; acknowledged_after_minutes: number | null };
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const lasted = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);

/** A glass window over the page. A native modal <dialog>: the browser keeps focus inside it, closes it on Esc and gives
 *  focus back afterwards. */
export function GlassDialog({ open, eyebrow, title, onClose, children }: { open: boolean; eyebrow: string; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Click outside closes it. Browsers that know closedby="any" do this themselves; for the rest, the press and the
  // release must both land outside the window (the pointer's place is tested, not the target: the dialog is also the
  // target for its own padding).
  useEffect(() => {
    const d = ref.current;
    if (!d || "closedBy" in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const outside = (e: PointerEvent) => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
    const down = (e: PointerEvent) => { pressedOutside = outside(e); };
    const up = (e: PointerEvent) => { if (pressedOutside && outside(e)) d.close(); };
    d.addEventListener("pointerdown", down);
    d.addEventListener("pointerup", up);
    return () => { d.removeEventListener("pointerdown", down); d.removeEventListener("pointerup", up); };
  }, []);

  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} className="glass-dialog" {...{ closedby: "any" }}>
      <div className="flex max-h-[inherit] flex-col">
        <header className="flex items-start gap-4 px-7 pb-4 pt-6">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-600 dark:text-zinc-300">{eyebrow}</p>
            <h2 id={titleId} className="mt-1 text-xl font-semibold leading-snug text-zinc-950 dark:text-zinc-50">{title}</h2>
          </div>
          <button type="button" autoFocus aria-label="Close" onClick={() => ref.current?.close()}
            className="rounded-full p-2 text-zinc-600 hover:bg-zinc-950/10 dark:text-zinc-300 dark:hover:bg-white/10"><X className="size-5" /></button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-7 pb-7">{children}</div>
      </div>
    </dialog>
  );
}

/** People's notes on a report, and the box to add one. A note is kept under the writer's name. */
export function Notes({ notes, canNote, onAdd }: { notes: Note[]; canNote: boolean; onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => { setBusy(true); if (await onAdd(text)) setText(""); setBusy(false); };
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">Notes</h3>
      {notes.length === 0 && <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">No notes yet.</p>}
      <ul className="mb-3 space-y-2">
        {notes.map((n) => (
          <li key={n.id} className="rounded-xl bg-white/60 px-4 py-3 text-sm dark:bg-white/10">
            <p className="whitespace-pre-wrap text-zinc-900 dark:text-zinc-100">{n.text}</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{n.by}, {when(n.at)}</p>
          </li>
        ))}
      </ul>
      {canNote && <>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Add a note" placeholder="Add a note. It is kept under your name." />
        <div className="mt-2 flex justify-end"><Button variant="primary" loading={busy} disabled={!text.trim()} onClick={add}>Add note</Button></div>
      </>}
    </section>
  );
}

/** Entries of a timeline: the time, what happened and who did it. */
export function Entries({ entries }: { entries: Entry[] }) {
  return (
    <ol className="border-l border-zinc-950/15 dark:border-white/20">
      {entries.map((e, n) => (
        <li key={`${e.at}${n}`} className="relative grid grid-cols-[5.5rem_1fr] gap-3 py-1.5 pl-5 text-sm">
          <span aria-hidden className="absolute -left-[4.5px] top-3 size-2 rounded-full bg-blue-600 dark:bg-blue-200" />
          <time dateTime={e.at} title={when(e.at)} className="tabular-nums text-zinc-600 dark:text-zinc-300">{clock(e.at)}</time>
          <span className="text-zinc-900 dark:text-zinc-100">{e.what}{e.who && <span className="text-zinc-600 dark:text-zinc-300"> by {e.who}</span>}</span>
        </li>
      ))}
    </ol>
  );
}

/** An incident report in a glass window: the facts, everything that happened in order, and people's notes. */
export function IncidentDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, error, loading, reload } = useApi<Incident>(id ? `/incidents/${id}` : null);
  const add = useAction((incident: string, note: string) => apiSend<Note>("post", `/incidents/${incident}/notes`, { text: note }));
  const onAdd = async (text: string) => { const ok = !!id && !!(await add.run(id, text)); if (ok) reload(); return ok; };
  const f = data?.facts;
  return (
    <GlassDialog open={!!id} eyebrow={`Incident report${f ? `, ${f.case_id}` : ""}`} title={f?.name ?? "Incident report"} onClose={onClose}>
      {(error || add.error) && <Alert tone="rose" className="mb-4">{(error ?? add.error)?.message}</Alert>}
      {loading && !data && <Spinner />}
      {data && f && <>
        <div className="mb-6 flex flex-wrap items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
          <Badge tone={f.status === "open" ? "blue" : "zinc"}>{f.status === "open" ? "Open" : "Closed"}</Badge>
          {f.priority && <Badge tone={f.priority === "P0" ? "rose" : "zinc"}>{f.priority}</Badge>}
          {f.product && <span>{f.product}</span>}
          <span>Started {when(f.started_at)}</span>
          <span>{f.ended_at ? `Ended ${when(f.ended_at)}` : "Still running"}</span>
          <span>{f.status === "open" ? "Running for" : "Lasted"} {lasted(f.minutes)}</span>
          {f.acknowledged_after_minutes !== null && <span>Acknowledged after {f.acknowledged_after_minutes} min</span>}
          <Link to={`/feed/${f.case_id}`} onClick={onClose} className="font-medium text-blue-700 hover:underline dark:text-blue-200">Open the alert</Link>
        </div>
        {data.sections.map((s) => (
          <section key={s.title} className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">{s.title}</h3>
            <Entries entries={s.entries} />
          </section>
        ))}
        <Notes notes={data.notes} canNote={data.can_note} onAdd={onAdd} />
      </>}
    </GlassDialog>
  );
}

interface Handover {
  id: string; shift: string; start: string; end: string; made_at: string; made_by: string; text: string; notes: Note[]; can_note: boolean;
  numbers: { alerts: number; acknowledged: number; escalated: number; emails_sent: number; tns_submitted: number; closed: number; median_ack_minutes: number | null };
  alerts: { case_id: string; name: string; priority: string; status: string; escalated: boolean; timeline: Entry[] }[];
  incidents: { id: string; name: string; status: "open" | "closed"; priority: string }[];
  cut: { shown: number; of: number } | null;
}

/** A shift's handover in a glass window: what was posted to the team space, the shift in numbers, its incident reports,
 *  each alert with its timeline, and people's notes. */
export function HandoverDialog({ id, onClose, onIncident }: { id: string | null; onClose: () => void; onIncident: (id: string) => void }) {
  const { data, error, loading, reload } = useApi<Handover>(id ? `/handovers/${id}` : null);
  const add = useAction((handover: string, note: string) => apiSend<Note>("post", `/handovers/${handover}/notes`, { text: note }));
  const onAdd = async (text: string) => { const ok = !!id && !!(await add.run(id, text)); if (ok) reload(); return ok; };
  const n = data?.numbers;
  return (
    <GlassDialog open={!!id} eyebrow={data ? `Handover, ${when(data.start)} to ${when(data.end)}` : "Handover"} title={data ? data.shift : "Handover"} onClose={onClose}>
      {(error || add.error) && <Alert tone="rose" className="mb-4">{(error ?? add.error)?.message}</Alert>}
      {loading && !data && <Spinner />}
      {data && n && <>
        <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          {([["Alerts with activity", n.alerts], ["Acknowledged", n.acknowledged], ["Escalated", n.escalated], ["Emails sent", n.emails_sent], ["T&S submitted", n.tns_submitted],
            ["Closed", n.closed], ["Typical time to acknowledge", n.median_ack_minutes === null ? "n/a" : `${n.median_ack_minutes} min`]] as [string, number | string][]).map(([label, value]) => (
            <div key={label}><dt className="text-xs text-zinc-600 dark:text-zinc-300">{label}</dt><dd className="text-lg font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{value}</dd></div>
          ))}
        </dl>
        <section className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">Posted to the team space</h3>
          <p className="whitespace-pre-wrap rounded-xl bg-white/60 px-4 py-3 text-sm text-zinc-900 dark:bg-white/10 dark:text-zinc-100">{data.text}</p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">Made {when(data.made_at)}{data.made_by !== "agent" ? ` by ${data.made_by}` : " when the shift ended"}</p>
        </section>
        {data.incidents.length > 0 && (
          <section className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">Incident reports in this shift</h3>
            <ul className="space-y-1.5">
              {data.incidents.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-sm">
                  <Badge tone={i.status === "open" ? "blue" : "zinc"}>{i.status === "open" ? "Open" : "Closed"}</Badge>
                  <button type="button" onClick={() => onIncident(i.id)} className="text-left font-medium text-blue-700 hover:underline dark:text-blue-200">{i.name}</button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">Alerts in this shift</h3>
          {data.alerts.length === 0 && <p className="text-sm text-zinc-600 dark:text-zinc-300">No alert had activity in this shift.</p>}
          {data.cut && <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-300">Showing {data.cut.shown} of {data.cut.of}.</p>}
          {data.alerts.map((a) => (
            <details key={a.case_id} className="border-b border-zinc-950/10 py-2 last:border-b-0 dark:border-white/15">
              <summary className="cursor-pointer text-sm text-zinc-900 dark:text-zinc-100">
                <span className="font-medium">{a.name || a.case_id}</span>
                <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-300">{a.case_id}{a.priority ? `, ${a.priority}` : ""}, {a.status.replace(/_/g, " ").toLowerCase()}{a.escalated ? ", escalated" : ""}</span>
              </summary>
              <div className="mt-2 pl-1"><Entries entries={a.timeline} /></div>
            </details>
          ))}
        </section>
        <Notes notes={data.notes} canNote={data.can_note} onAdd={onAdd} />
      </>}
    </GlassDialog>
  );
}
