import { Plus, Trash } from "lucide-react";
import { useState } from "react";

import { apiSend, type FieldError } from "../api/client";
import type { Person, Roster, RosterView, RotationSlot } from "../api/types";
import { useApp } from "../context";
import { Alert, Button, cx, Field, Input, Modal, Select } from "./ui";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
type Draft = Pick<Roster, "people" | "rotation" | "backup_person_id" | "fallback" | "reminders">;

const SMALL = "px-2 py-1.5 text-xs";

export function RosterEditor({ view, open, onClose, onSaved }: { view: RosterView; open: boolean; onClose: () => void; onSaved: (v: RosterView) => void }) {
  const { toast } = useApp();
  const [draft, setDraft] = useState<Draft>(() => structuredClone({
    people: view.roster.people, rotation: view.roster.rotation, backup_person_id: view.roster.backup_person_id,
    fallback: view.roster.fallback, reminders: view.roster.reminders,
  }));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const setPerson = (i: number, patch: Partial<Person>) => setDraft((d) => ({ ...d, people: d.people.map((p, n) => (n === i ? { ...p, ...patch } : p)) }));
  const setSlot = (i: number, patch: Partial<RotationSlot>) => setDraft((d) => ({ ...d, rotation: d.rotation.map((s, n) => (n === i ? { ...s, ...patch } : s)) }));
  const errFor = (...loc: (string | number)[]) => errors.find((e) => loc.every((l, i) => String(e.loc[i]) === String(l)))?.msg;

  const save = async () => {
    setSaving(true);
    setErrors([]);
    try {
      const saved = await apiSend<RosterView>("put", `/rosters/${view.name}`, draft);
      toast(`${view.label} saved`);
      onSaved(saved);
      onClose();
    } catch (err) {
      const e = err as { errors?: FieldError[]; message?: string };
      setErrors(e.errors ?? []);
      toast(e.message ?? "Couldn't save the roster", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal wide open={open} onClose={onClose} title={`Edit ${view.label}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save roster</Button></>}>
      {errors.length > 0 && (
        <Alert tone="rose" className="mb-4" title="Fix these before saving">
          <ul className="list-disc pl-4 text-xs">{errors.map((e, i) => <li key={i}><span className="font-mono">{e.loc.join(".")}</span>: {e.msg}</li>)}</ul>
        </Alert>
      )}
      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">People</h4>
        {draft.people.map((p, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Input className={cx(SMALL, "col-span-2")} value={p.id} onChange={(e) => setPerson(i, { id: e.target.value })} placeholder="id" aria-label="Person id" aria-invalid={!!errFor("people", i, "id")} />
            <Input className={cx(SMALL, "col-span-3")} value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} placeholder="Name" aria-label="Name" />
            <Input className={cx(SMALL, "col-span-4")} value={p.email} onChange={(e) => setPerson(i, { email: e.target.value })} placeholder="email" aria-label="Email" aria-invalid={!!errFor("people", i, "email")} />
            <Input className={cx(SMALL, "col-span-2")} value={p.org} onChange={(e) => setPerson(i, { org: e.target.value })} placeholder="org" aria-label="Org" />
            <button type="button" aria-label="Remove person" className="col-span-1 rounded-md text-zinc-400 hover:text-rose-600" onClick={() => setDraft((d) => ({ ...d, people: d.people.filter((_, n) => n !== i) }))}><Trash className="mx-auto size-4" /></button>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setDraft((d) => ({ ...d, people: [...d.people, { id: "", name: "", email: "", org: view.name === "burson" ? "burson" : "insight_global" }] }))}>Add person</Button>
      </section>

      <section className="mt-5 space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Weekly rotation</h4>
        <p className="text-xs text-zinc-500">If the end is earlier than the start, the slot runs past midnight (days = the day it starts).</p>
        {draft.rotation.map((s, i) => (
          <div key={i} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
            <div className="grid grid-cols-12 gap-2">
              <Select className={cx(SMALL, "col-span-3")} value={s.person_id} onChange={(e) => setSlot(i, { person_id: e.target.value })} aria-label="Person">
                {draft.people.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
              </Select>
              <Input type="time" className={cx(SMALL, "col-span-2")} value={s.start} onChange={(e) => setSlot(i, { start: e.target.value })} aria-label="Start" />
              <Input type="time" className={cx(SMALL, "col-span-2")} value={s.end} onChange={(e) => setSlot(i, { end: e.target.value })} aria-label="End" />
              <Input className={cx(SMALL, "col-span-4")} value={s.tz} onChange={(e) => setSlot(i, { tz: e.target.value })} aria-label="Timezone" aria-invalid={!!errFor("rotation", i, "tz")} />
              <button type="button" aria-label="Remove slot" className="col-span-1 text-zinc-400 hover:text-rose-600" onClick={() => setDraft((d) => ({ ...d, rotation: d.rotation.filter((_, n) => n !== i) }))}><Trash className="mx-auto size-4" /></button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {DAYS.map((day) => {
                const on = s.days.includes(day);
                return (
                  <button key={day} type="button" aria-pressed={on} onClick={() => setSlot(i, { days: on ? s.days.filter((x) => x !== day) : DAYS.filter((x) => x === day || s.days.includes(x)) })}
                    className={cx("rounded-md px-2 py-0.5 text-xs font-medium capitalize transition-colors", on ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800")}>
                    {day}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={!draft.people.length}
          onClick={() => setDraft((d) => ({ ...d, rotation: [...d.rotation, { person_id: d.people[0]?.id ?? "", days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00", tz: view.timezone }] }))}>
          Add slot
        </Button>
      </section>

      <section className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Backup (when nobody is scheduled)" error={errFor("backup_person_id")}>
          <Select value={draft.backup_person_id ?? ""} onChange={(e) => setDraft((d) => ({ ...d, backup_person_id: e.target.value || null }))}>
            <option value="">None</option>
            {draft.people.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
          </Select>
        </Field>
        <Field label="Fallback (name · email)" error={errFor("fallback", "email")}>
          <div className="flex gap-2">
            <Input value={draft.fallback?.name ?? ""} placeholder="Name" onChange={(e) => setDraft((d) => ({ ...d, fallback: { id: d.fallback?.id || "fallback", org: d.fallback?.org || "", email: d.fallback?.email ?? "", name: e.target.value } }))} />
            <Input value={draft.fallback?.email ?? ""} placeholder="email" onChange={(e) => setDraft((d) => ({ ...d, fallback: { id: d.fallback?.id || "fallback", org: d.fallback?.org || "", name: d.fallback?.name ?? "", email: e.target.value } }))} />
          </div>
        </Field>
        {(["reping_after_min", "backup_after_min", "notify_analyst_after_min", "max_reminders"] as const).map((key) => (
          <Field key={key} label={{ reping_after_min: "Re-ping after (min)", backup_after_min: "Backup after (min)", notify_analyst_after_min: "Notify IM after (min)", max_reminders: "Max reminders" }[key]}>
            <Input type="number" min={0} value={draft.reminders[key]} onChange={(e) => setDraft((d) => ({ ...d, reminders: { ...d.reminders, [key]: Number(e.target.value) } }))} />
          </Field>
        ))}
      </section>
    </Modal>
  );
}
