import { useState } from "react";

import { apiSend } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { CalendarCard } from "./EventCalendar";
import { HandoverDialog, IncidentDialog } from "./IncidentDialog";
import { Alert, Button, Card, EmptyState, TD, TH, TR } from "./ui";

interface Row { id: string; shift: string; start: string; end: string; made_at: string; made_by: string; notes: number }
interface Listed {
  handovers: Row[]; can_make: boolean; posts_to_team: boolean;
  last_shift: { shift: string; start: string; end: string; done: boolean };
}

const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const hours = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Workforce's handovers: the last shift's handover and the ones before it, then the calendar they and the incident
 *  reports show on. */
export function ShiftHandovers() {
  const { data, error, reload } = useApi<Listed>("/handovers", undefined, 60_000);
  const [open, setOpen] = useState<string | null>(null);
  const [incident, setIncident] = useState<string | null>(null);
  const [made, setMade] = useState(0);
  const make = useAction(() => apiSend<Row>("post", "/handovers"));
  const onMake = async () => {
    const h = await make.run();
    if (h) { setMade(made + 1); reload(); setOpen(h.id); }
  };
  const last = data?.last_shift;

  return (
    <>
      <Card padded={false} title="Handovers" subtitle={data?.posts_to_team ? "One for each shift, made when the shift ends and posted to the team space." : "One for each shift, made when the shift ends. Posting to the team space is off."}
        actions={data?.can_make && last && !last.done ? <Button variant="primary" loading={make.loading} onClick={onMake}>Make the handover for {last.shift} now</Button> : undefined}>
        {(error || make.error) && <Alert tone="rose" className="mx-5 mb-3">{(error ?? make.error)?.message}</Alert>}
        {data && data.handovers.length === 0 ? <EmptyState title="No handover yet">The first one is made when the current shift ends.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr><th className={TH}>Shift</th><th className={TH}>Hours</th><th className={TH}>Made</th><th className={TH}>Notes</th></tr></thead>
              <tbody>
                {data?.handovers.slice(0, 8).map((h) => (
                  <tr key={h.id} className={TR}>
                    <td className={TD}><button type="button" onClick={() => setOpen(h.id)} className="font-medium text-blue-700 hover:underline dark:text-blue-200">{h.shift}</button></td>
                    <td className={TD}>{when(h.start)} to {hours(h.end)}</td>
                    <td className={TD}>{h.made_by === "agent" ? "When the shift ended" : `By ${h.made_by}`}</td>
                    <td className={TD}>{h.notes || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <CalendarCard title="Calendar" refreshKey={made} />
      <HandoverDialog id={open} onClose={() => { setOpen(null); reload(); }} onIncident={(id) => { setOpen(null); setIncident(id); }} />
      <IncidentDialog id={incident} onClose={() => setIncident(null)} />
    </>
  );
}
