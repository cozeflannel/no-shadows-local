import type { ScheduleView } from "../api/types";
import { fmtDay, fmtTime, tzAbbr } from "../lib/format";
import { CHART_COLORS } from "../lib/labels";
import { cx } from "./ui";

const HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

export function personColor(people: { id: string }[], id: string | null): string {
  const i = people.findIndex((p) => p.id === id);
  return i < 0 ? "#a1a1aa" : CHART_COLORS[i % CHART_COLORS.length];
}

/** 7-day timeline: one row per day (display timezone), colored blocks per person, gaps hatched. */
export function WeekSchedule({ schedule }: { schedule: ScheduleView }) {
  const now = new Date(schedule.now).getTime();
  return (
    <div className="scroll-thin overflow-x-auto">
      <div className="min-w-[720px]">
        <div className="ml-28 flex justify-between pb-1 text-[11px] text-zinc-400">
          {HOURS.map((h) => <span key={h} className="w-0 whitespace-nowrap text-center">{h === 24 ? "" : `${String(h).padStart(2, "0")}:00`}</span>)}
        </div>
        <div className="space-y-1.5">
          {schedule.days.map((day) => {
            const dayStart = day.blocks[0] ? new Date(day.blocks[0].start).getTime() - day.blocks[0].start_min * 60_000 : 0;
            const nowMin = (now - dayStart) / 60_000;
            const isToday = nowMin >= 0 && nowMin < day.minutes;
            return (
              <div key={day.date} className="flex items-center gap-2">
                <div className={cx("w-26 shrink-0 text-xs", isToday ? "font-semibold text-blue-600 dark:text-blue-400" : "text-zinc-500")}>
                  {fmtDay(`${day.date}T12:00:00Z`)}
                </div>
                <div className="relative h-9 flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800/60">
                  {HOURS.slice(1, -1).map((h) => <div key={h} className="absolute inset-y-0 w-px bg-white/70 dark:bg-zinc-900/70" style={{ left: `${(h / 24) * 100}%` }} />)}
                  {day.blocks.map((b, i) => {
                    const left = (b.start_min / day.minutes) * 100;
                    const width = ((b.end_min - b.start_min) / day.minutes) * 100;
                    const label = `${b.name ?? "Nobody"} · ${b.source} · ${fmtTime(b.start)}–${fmtTime(b.end)} ${tzAbbr()}`;
                    return (
                      <div key={i} title={label} aria-label={label}
                        className={cx("absolute inset-y-0.5 flex items-center overflow-hidden rounded px-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90",
                          b.gap && "ring-2 ring-inset ring-rose-500")}
                        style={{
                          left: `${left}%`, width: `${Math.max(width, 0.4)}%`,
                          background: b.gap
                            ? "repeating-linear-gradient(45deg, rgb(244 63 94 / 0.85), rgb(244 63 94 / 0.85) 6px, rgb(251 113 133 / 0.55) 6px, rgb(251 113 133 / 0.55) 12px)"
                            : personColor(schedule.people, b.person_id),
                        }}>
                        {width > 7 && <span className="truncate">{b.gap ? `Gap · ${b.name ?? "nobody"} (${b.source})` : `${b.name}${b.source === "override" ? " ★" : ""}`}</span>}
                      </div>
                    );
                  })}
                  {isToday && <div className="absolute inset-y-0 z-10 w-0.5 bg-zinc-900 dark:bg-white" style={{ left: `${(nowMin / day.minutes) * 100}%` }} title="Now" />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ml-28 mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
          {schedule.people.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: personColor(schedule.people, p.id) }} />{p.name}</span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-rose-500" />Coverage gap (backup / fallback only)</span>
          <span>★ override</span>
          <span>Times in {tzAbbr()}</span>
        </div>
      </div>
    </div>
  );
}
