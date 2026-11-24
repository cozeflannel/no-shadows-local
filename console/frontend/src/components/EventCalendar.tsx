import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "../api/hooks";
import { IncidentDialog } from "./IncidentDialog";
import { Alert, Button, Card, cx, Segmented } from "./ui";

export interface CalEvent { kind: "incident" | "handover"; id: string; title: string; start: string; end: string; open: boolean; priority: string; notes: number }
interface Feed { events: CalEvent[]; incident_reports: { on: boolean; why: string }; can_open: boolean }
type View = "month" | "week";

const DAY = 86_400_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekStart = (d: Date) => addDays(dayStart(d), -d.getDay());
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
const tone = (e: CalEvent) => (e.priority === "P0" ? "bg-rose-600 text-white dark:bg-rose-300 dark:text-rose-950"
  : e.open ? "bg-blue-600 text-white dark:bg-blue-200 dark:text-blue-950" : "bg-zinc-300 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100");

/** The part of an event that falls on one day, as minutes from midnight. */
function slice(e: CalEvent, day: Date): { from: number; to: number } | null {
  const a = Math.max(new Date(e.start).getTime(), day.getTime());
  const b = Math.min(new Date(e.end).getTime(), day.getTime() + DAY);
  return b > a || (a === b && a >= day.getTime() && a < day.getTime() + DAY) ? { from: (a - day.getTime()) / 60_000, to: Math.max((b - day.getTime()) / 60_000, (a - day.getTime()) / 60_000 + 30) } : null;
}

/** Events that overlap share the day's width side by side, as on any calendar. */
function lanes(items: { e: CalEvent; from: number; to: number }[]) {
  const sorted = [...items].sort((x, y) => x.from - y.from || y.to - x.to);
  const ends: number[] = [];
  const placed = sorted.map((it) => {
    let lane = ends.findIndex((end) => end <= it.from);
    if (lane === -1) lane = ends.length;
    ends[lane] = it.to;
    return { ...it, lane };
  });
  return { placed, count: Math.max(1, ends.length) };
}

function Month({ anchor, events, onOpen, onDay }: { anchor: Date; events: CalEvent[]; onOpen: (e: CalEvent) => void; onDay: (d: Date) => void }) {
  const first = weekStart(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const today = new Date();
  return (
    <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      {DAYS.map((d) => <div key={d} className="border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">{d}</div>)}
      {Array.from({ length: 42 }, (_, n) => addDays(first, n)).map((day) => {
        const here = events.filter((e) => slice(e, day));
        const out = day.getMonth() !== anchor.getMonth();
        return (
          <div key={day.toISOString()} className={cx("min-h-24 border-b border-r border-zinc-200 p-1.5 [&:nth-child(7n)]:border-r-0 dark:border-zinc-800", out && "bg-zinc-50/60 dark:bg-zinc-900/40")}>
            <button type="button" onClick={() => onDay(day)} aria-label={`Open the week of ${day.toLocaleDateString([], { month: "long", day: "numeric" })}`}
              className={cx("mb-1 grid size-6 place-items-center rounded-full text-xs tabular-nums hover:bg-zinc-200 dark:hover:bg-zinc-700",
                sameDay(day, today) ? "bg-blue-600 font-semibold text-white dark:bg-blue-200 dark:text-blue-950" : out ? "text-zinc-400" : "text-zinc-700 dark:text-zinc-200")}>{day.getDate()}</button>
            <div className="space-y-1">
              {here.slice(0, 3).map((e) => (
                <button key={e.id} type="button" onClick={() => onOpen(e)} title={e.title} className={cx("block w-full truncate rounded px-1.5 py-0.5 text-left text-xs font-medium", tone(e))}>{e.title}</button>
              ))}
              {here.length > 3 && <button type="button" onClick={() => onDay(day)} className="text-xs text-blue-700 hover:underline dark:text-blue-200">{here.length - 3} more</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Week({ anchor, events, onOpen }: { anchor: Date; events: CalEvent[]; onOpen: (e: CalEvent) => void }) {
  const first = weekStart(anchor);
  const today = new Date();
  const HOUR = 44; // px for one hour
  return (
    <div className="scroll-thin max-h-[34rem] overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="sticky top-0 z-10 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
        <div />
        {Array.from({ length: 7 }, (_, n) => addDays(first, n)).map((d) => (
          <div key={d.toISOString()} className={cx("px-2 py-1.5 text-xs font-medium", sameDay(d, today) ? "text-blue-700 dark:text-blue-200" : "text-zinc-600 dark:text-zinc-300")}>{DAYS[d.getDay()]} {d.getDate()}</div>
        ))}
      </div>
      <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]" style={{ height: 24 * HOUR }}>
        <div className="relative">
          {Array.from({ length: 23 }, (_, h) => <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-zinc-500" style={{ top: (h + 1) * HOUR }}>{hour(h + 1)}</span>)}
        </div>
        {Array.from({ length: 7 }, (_, n) => addDays(first, n)).map((day) => {
          const { placed, count } = lanes(events.flatMap((e) => { const s = slice(e, day); return s ? [{ e, ...s }] : []; }));
          return (
            <div key={day.toISOString()} className="relative border-l border-zinc-200 dark:border-zinc-800"
              style={{ backgroundImage: "linear-gradient(to bottom, color-mix(in srgb, currentColor 10%, transparent) 1px, transparent 1px)", backgroundSize: `100% ${HOUR}px` }}>
              {placed.map(({ e, from, to, lane }) => (
                <button key={e.id} type="button" onClick={() => onOpen(e)} title={e.title}
                  className={cx("absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs font-medium leading-tight shadow-sm", tone(e))}
                  style={{ top: (from / 60) * HOUR, height: Math.max(((to - from) / 60) * HOUR - 2, 20), left: `calc(${(lane / count) * 100}% + 2px)`, width: `calc(${100 / count}% - 4px)` }}>{e.title}</button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Incident reports (and handovers) on a calendar, by month or week. Clicking one opens it in a window over the page. */
export function CalendarCard({ title = "Calendar", className }: { title?: string; className?: string }) {
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => dayStart(new Date()));
  const [open, setOpen] = useState<string | null>(null);
  const [from, to] = useMemo(() => {
    const a = view === "month" ? weekStart(new Date(anchor.getFullYear(), anchor.getMonth(), 1)) : weekStart(anchor);
    return [a, addDays(a, view === "month" ? 42 : 7)];
  }, [view, anchor]);
  const params = useMemo(() => ({ start: from.toISOString(), end: to.toISOString() }), [from, to]);
  const { data, error, reload } = useApi<Feed>("/calendar", params, 60_000);
  const move = (n: number) => setAnchor(view === "month" ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : addDays(anchor, 7 * n));
  const heading = view === "month" ? anchor.toLocaleDateString([], { month: "long", year: "numeric" })
    : `${from.toLocaleDateString([], { month: "short", day: "numeric" })} to ${addDays(to, -1).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
  const events = data?.events ?? [];

  return (
    <Card className={className} title={title} subtitle="Incident reports, from each alert's arrival to its end. Click one to open it."
      actions={<div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setAnchor(dayStart(new Date()))}>Today</Button>
        <Button aria-label={view === "month" ? "Earlier month" : "Earlier week"} icon={<ChevronLeft className="size-4" />} onClick={() => move(-1)} />
        <Button aria-label={view === "month" ? "Later month" : "Later week"} icon={<ChevronRight className="size-4" />} onClick={() => move(1)} />
        <Segmented<View> label="Calendar view" value={view} onChange={setView} options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]} />
      </div>}>
      <p className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100" aria-live="polite">{heading}</p>
      {error && <Alert tone="rose" className="mb-3">{error.message}</Alert>}
      {data && !data.incident_reports.on && (
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">Incident reports are not opened automatically: {data.incident_reports.why}. One a person opened still shows here.</p>
      )}
      {view === "month" ? <Month anchor={anchor} events={events} onOpen={(e) => setOpen(e.id)} onDay={(d) => { setAnchor(d); setView("week"); }} />
        : <Week anchor={anchor} events={events} onOpen={(e) => setOpen(e.id)} />}
      <IncidentDialog id={open} onClose={() => { setOpen(null); reload(); }} />
    </Card>
  );
}
