import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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

/** An incident report in a window over the page: the facts, everything that happened in order, and people's notes.
 *  A native modal <dialog>: the browser keeps focus inside it, closes it on Esc and gives focus back afterwards. */
export function IncidentDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { data, error, loading, reload } = useApi<Incident>(id ? `/incidents/${id}` : null);
  const [text, setText] = useState("");
  const add = useAction((incident: string, note: string) => apiSend<Note>("post", `/incidents/${incident}/notes`, { text: note }));

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (id && !d.open) d.showModal();
    if (!id && d.open) d.close();
  }, [id]);

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

  const onAdd = async () => {
    if (!id) return;
    if (await add.run(id, text)) { setText(""); reload(); }
  };
  const f = data?.facts;

  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} className="glass-dialog" {...{ closedby: "any" }}>
      <div className="flex max-h-[inherit] flex-col">
        <header className="flex items-start gap-4 px-7 pb-4 pt-6">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-600 dark:text-zinc-300">Incident report{f ? `, ${f.case_id}` : ""}</p>
            <h2 id={titleId} className="mt-1 text-xl font-semibold leading-snug text-zinc-950 dark:text-zinc-50">{f?.name ?? "Incident report"}</h2>
          </div>
          <button type="button" autoFocus aria-label="Close" onClick={() => ref.current?.close()}
            className="rounded-full p-2 text-zinc-600 hover:bg-zinc-950/10 dark:text-zinc-300 dark:hover:bg-white/10"><X className="size-5" /></button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-7 pb-7">
          {error && <Alert tone="rose" className="mb-4">{error.message}</Alert>}
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
              <Link to={`/feed/${f.case_id}`} onClick={() => ref.current?.close()} className="font-medium text-blue-700 hover:underline dark:text-blue-200">Open the alert</Link>
            </div>
            {data.sections.map((s) => (
              <section key={s.title} className="mb-6">
                <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">{s.title}</h3>
                <ol className="border-l border-zinc-950/15 dark:border-white/20">
                  {s.entries.map((e, n) => (
                    <li key={`${e.at}${n}`} className="relative grid grid-cols-[5.5rem_1fr] gap-3 py-1.5 pl-5 text-sm">
                      <span aria-hidden className="absolute -left-[4.5px] top-3 size-2 rounded-full bg-blue-600 dark:bg-blue-200" />
                      <time dateTime={e.at} title={when(e.at)} className="tabular-nums text-zinc-600 dark:text-zinc-300">{clock(e.at)}</time>
                      <span className="text-zinc-900 dark:text-zinc-100">{e.what}{e.who && <span className="text-zinc-600 dark:text-zinc-300"> by {e.who}</span>}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            <section>
              <h3 className="mb-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">Notes</h3>
              {data.notes.length === 0 && <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">No notes yet.</p>}
              <ul className="mb-3 space-y-2">
                {data.notes.map((n) => (
                  <li key={n.id} className="rounded-xl bg-white/60 px-4 py-3 text-sm dark:bg-white/10">
                    <p className="whitespace-pre-wrap text-zinc-900 dark:text-zinc-100">{n.text}</p>
                    <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{n.by}, {when(n.at)}</p>
                  </li>
                ))}
              </ul>
              {data.can_note && <>
                {add.error && <Alert tone="rose" className="mb-2">{add.error.message}</Alert>}
                <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Add a note" placeholder="Add a note. It is kept under your name." />
                <div className="mt-2 flex justify-end"><Button variant="primary" loading={add.loading} disabled={!text.trim()} onClick={onAdd}>Add note</Button></div>
              </>}
            </section>
          </>}
        </div>
      </div>
    </dialog>
  );
}
