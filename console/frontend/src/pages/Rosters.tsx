import { Pencil, Plus, RefreshCw, Trash, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { apiSend } from "../api/client";
import { useApi } from "../api/hooks";
import type { Override, RosterView, ScheduleView } from "../api/types";
import { RosterEditor } from "../components/RosterEditor";
import { Alert, Badge, Button, Card, cx, ErrorState, Field, Input, PageHeader, Segmented, Select, Spinner, Tabs, TD, TH, TR } from "../components/ui";
import { personColor, WeekSchedule } from "../components/WeekSchedule";
import { useApp } from "../context";
import { fmtDateTime, fmtDuration, fmtTime, tzAbbr } from "../lib/format";
import { ONCALL_SOURCE_TONE } from "../lib/labels";

type Name = "slrr_im" | "burson";

function OverrideForm({ view, onSaved, disabled }: { view: RosterView; onSaved: (v: RosterView) => void; disabled: boolean }) {
  const { toast } = useApp();
  const [person, setPerson] = useState(view.roster.people[0]?.id ?? "");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      // datetime-local values are naive: the API reads them in the display timezone.
      const res = await apiSend<RosterView & { override: Override }>("post", `/rosters/${view.name}/overrides`, { person_id: person, start, end, reason: reason || undefined });
      toast("Override added");
      setStart(""); setEnd(""); setReason("");
      onSaved(res);
    } catch (err) {
      const e = err as { message?: string; errors?: { msg: string }[] };
      toast(e.errors?.map((x) => x.msg).join("; ") || e.message || "Couldn't add the override", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Field label="Person"><Select value={person} onChange={(e) => setPerson(e.target.value)} disabled={disabled}>{view.roster.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
      <Field label={`Start (${tzAbbr()})`}><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={disabled} /></Field>
      <Field label={`End (${tzAbbr()})`}><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} disabled={disabled} /></Field>
      <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Covering a shift swap" disabled={disabled} /></Field>
      <div className="flex items-end"><Button variant="primary" icon={<Plus className="size-4" />} loading={busy} disabled={disabled || !person || !start || !end} onClick={submit} className="w-full">Add override</Button></div>
    </div>
  );
}

export default function RostersPage() {
  const { me, toast } = useApp();
  const [search, setSearch] = useSearchParams();
  const name: Name = search.get("tab") === "burson" ? "burson" : "slrr_im";
  const [days, setDays] = useState(7);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const roster = useApi<RosterView>(`/rosters/${name}`);
  const schedule = useApi<ScheduleView>(`/rosters/${name}/schedule`, { days });
  const view = roster.data;
  const nowMs = Date.now();

  const refresh = (v?: RosterView) => {
    if (v) roster.setData(v); else roster.reload();
    schedule.reload();
  };
  const remove = async (id: string) => {
    setRemoving(id);
    try {
      refresh(await apiSend<RosterView>("delete", `/rosters/${name}/overrides/${id}`));
      toast("Override removed");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't remove the override", "error");
    } finally {
      setRemoving(null);
    }
  };
  const people = view?.roster.people ?? [];
  const personName = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const overrides = [...(view?.roster.overrides ?? [])].sort((a, b) => b.start.localeCompare(a.start));

  return (
    <div>
      <PageHeader title="Rosters" description="Who the agent @mentions: Incident Managers on shift (reviews, SLA nudges, drafts) and the Burson on-call (alerts that need a corrected rerun)."
        actions={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => refresh()}>Refresh</Button>} />
      <Tabs<Name> value={name} onChange={(v) => setSearch(v === "burson" ? { tab: "burson" } : {}, { replace: true })}
        tabs={[{ key: "slrr_im", label: "IM shifts" }, { key: "burson", label: "Burson on-call" }]} />
      <ErrorState error={roster.error} onRetry={roster.reload} />
      {!view ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="On call now">
              {view.on_call_now.person ? (
                <div>
                  <p className="text-lg font-semibold">{view.on_call_now.person.name}</p>
                  <p className="text-sm text-zinc-500">{view.on_call_now.person.email}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={ONCALL_SOURCE_TONE[view.on_call_now.source] ?? "zinc"}>{view.on_call_now.source}</Badge>
                    {view.on_call_now.until && <span className="text-zinc-500">until {fmtTime(view.on_call_now.until)} {tzAbbr()}</span>}
                    {view.next?.name && <span className="text-zinc-500">· then {view.next.name}</span>}
                  </div>
                </div>
              ) : <Alert tone="rose" title="Nobody is on call" />}
              <p className="mt-3 text-xs text-zinc-500">Escalation chain: {view.escalation_chain.map((p) => p.name).join(" → ") || "—"}</p>
            </Card>
            <Card className="lg:col-span-2" title="People" subtitle={view.description}
              actions={me?.is_admin && <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>Edit roster</Button>}>
              <div className="flex flex-wrap gap-2">
                {people.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm dark:border-zinc-800">
                    <span className="size-2.5 rounded-full" style={{ background: personColor(people, p.id) }} />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-zinc-500">{p.email}</span>
                    {view.roster.backup_person_id === p.id && <Badge tone="amber">backup</Badge>}
                  </span>
                ))}
                {view.roster.fallback && <span className="inline-flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700"><Badge tone="orange">fallback</Badge>{view.roster.fallback.name} · <span className="text-xs text-zinc-500">{view.roster.fallback.email}</span></span>}
              </div>
              <table className="mt-4 w-full">
                <thead><tr><th className={TH}>Rotation</th><th className={TH}>Days</th><th className={TH}>Hours</th></tr></thead>
                <tbody>{view.roster.rotation.map((s, i) => (
                  <tr key={i} className={TR}>
                    <td className={TD}>{personName(s.person_id)}</td>
                    <td className={cx(TD, "text-xs capitalize")}>{s.days.join(", ")}</td>
                    <td className={cx(TD, "font-mono text-xs")}>{s.start}–{s.end} <span className="text-zinc-400">{s.tz}</span></td>
                  </tr>
                ))}</tbody>
              </table>
              <p className="mt-3 text-xs text-zinc-500">Reminders: re-ping after {view.roster.reminders.reping_after_min} min · backup after {view.roster.reminders.backup_after_min} min · IM after {view.roster.reminders.notify_analyst_after_min} min · max {view.roster.reminders.max_reminders}
                {view.roster.updated_by && <> · last edited by {view.roster.updated_by} {fmtDateTime(view.roster.updated_at)}</>}</p>
            </Card>
          </div>

          <Card title="Schedule" subtitle={schedule.data ? `${schedule.data.gaps.length} coverage gap${schedule.data.gaps.length === 1 ? "" : "s"} (${fmtDuration(schedule.data.gap_minutes * 60)})` : undefined}
            actions={<Segmented label="Days" value={days} onChange={setDays} options={[{ value: 7, label: "1 week" }, { value: 14, label: "2 weeks" }]} />}>
            {schedule.data ? <WeekSchedule schedule={schedule.data} /> : <Spinner />}
            {schedule.data && schedule.data.gaps.length > 0 && (
              <div className="mt-4 flex items-start gap-2 text-xs text-rose-700 dark:text-rose-400">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>Gaps fall back to {view.roster.backup_person_id ? `the backup (${personName(view.roster.backup_person_id)})` : "the fallback"}: {schedule.data.gaps.slice(0, 4).map((g) => `${fmtDateTime(g.start)}–${fmtTime(g.end)}`).join("; ")}{schedule.data.gaps.length > 4 ? " …" : ""}</span>
              </div>
            )}
          </Card>

          <Card title="Overrides" subtitle="Temporary coverage (newest first). The most recently created override wins when they overlap.">
            {!me?.can_act && <Alert tone="blue" className="mb-3" title="Read-only">Analysts, IMs and admins can add or remove overrides.</Alert>}
            <OverrideForm view={view} onSaved={refresh} disabled={!me?.can_act} />
            <table className="mt-4 w-full">
              <thead><tr><th className={TH}>Person</th><th className={TH}>When</th><th className={TH}>Reason</th><th className={TH}>Set by</th><th className={TH} /></tr></thead>
              <tbody>
                {overrides.length === 0 && <tr><td className={cx(TD, "text-zinc-500")} colSpan={5}>No overrides.</td></tr>}
                {overrides.map((o) => {
                  const past = new Date(o.end).getTime() < nowMs;
                  const active = !past && new Date(o.start).getTime() <= nowMs;
                  return (
                    <tr key={o.override_id} className={cx(TR, past && "opacity-50")}>
                      <td className={TD}>{personName(o.person_id)} {active && <Badge tone="violet">active</Badge>}</td>
                      <td className={cx(TD, "text-xs")}>{fmtDateTime(o.start)} → {fmtDateTime(o.end)}</td>
                      <td className={cx(TD, "text-xs")}>{o.reason ?? "—"}</td>
                      <td className={cx(TD, "text-xs")}>{o.set_by} <span className="text-zinc-400">via {o.set_via}</span></td>
                      <td className={cx(TD, "text-right")}>
                        {!past && <Button size="sm" variant="ghost" icon={<Trash className="size-3.5" />} disabled={!me?.can_act} loading={removing === o.override_id} onClick={() => remove(o.override_id)}>Remove</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          {editing && <RosterEditor view={view} open={editing} onClose={() => setEditing(false)} onSaved={refresh} />}
        </div>
      )}
    </div>
  );
}
