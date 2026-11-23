import { Check, ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { RANGES, type Dimension, type Option, type RangeName } from "../lib/dashboard";
import { cx } from "./ui";

/** The time range: Today, Last 24 hours, Last 7 days, Last 30 days, or Custom days (midnight to midnight, display timezone). */
export function RangePicker({ range, from, to, tzLabel, onRange, onDates }: {
  range: RangeName; from: string; to: string; tzLabel: string; onRange: (r: RangeName) => void; onDates: (from: string, to: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Time range" className="scroll-thin inline-flex max-w-full overflow-x-auto rounded-full bg-zinc-100 p-1 dark:bg-zinc-900 dark:ring-1 dark:ring-zinc-800">
        {RANGES.map((r) => (
          <button key={r.value} type="button" onClick={() => onRange(r.value)} aria-pressed={r.value === range}
            className={cx("whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors",
              r.value === range ? "bg-white text-blue-700 shadow-sm dark:bg-zinc-800 dark:text-blue-200" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100")}>
            {r.label}
          </button>
        ))}
      </div>
      {range === "custom" && (
        <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <label className="inline-flex items-center gap-1.5">From
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && onDates(e.target.value, to)}
              className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" />
          </label>
          <label className="inline-flex items-center gap-1.5">to
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && onDates(from, e.target.value)}
              className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" />
          </label>
        </span>
      )}
      <span className="text-xs text-zinc-500">{tzLabel} time</span>
    </div>
  );
}

/** One filter: a button that opens a list of choices with how many alert messages each has (several can be picked). */
export function FilterMenu({ dim, options, selected, onChange }: { dim: Dimension; options: Option[]; selected: string[]; onChange: (values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    window.setTimeout(() => search.current?.focus(), 0);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key); };
  }, [open]);

  const labelOf = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options]);
  const shown = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, needle]);
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  const summary = selected.length === 0 ? "All" : `${labelOf.get(selected[0]) ?? selected[0]}${selected.length > 1 ? ` +${selected.length - 1}` : ""}`;

  return (
    <div className="relative" ref={box}>
      <button ref={button} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={id}
        className={cx("inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
          selected.length ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-300/40 dark:bg-blue-200/10 dark:text-blue-100"
            : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800")}>
        <span className="shrink-0 font-medium">{dim.label}:</span>
        <span className="truncate">{summary}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={`Filter by ${dim.label}`}
          className="absolute left-0 top-10 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
          {options.length > 8 && (
            <label className="mb-1 flex items-center gap-2 rounded-xl border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-700">
              <Search className="size-3.5 text-zinc-400" aria-hidden />
              <input ref={search} value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder={`Find a ${dim.label.toLowerCase()}`}
                aria-label={`Find a ${dim.label.toLowerCase()}`} className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100" />
            </label>
          )}
          <ul className="scroll-thin max-h-72 overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label={dim.label}>
            {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-zinc-500">Nothing matches.</li>}
            {shown.map((o) => {
              const on = selected.includes(o.value);
              return (
                <li key={o.value || "(blank)"} role="option" aria-selected={on}>
                  <button type="button" onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <span className={cx("flex size-4 shrink-0 items-center justify-center rounded border",
                      on ? "border-blue-600 bg-blue-600 text-white dark:border-blue-200 dark:bg-blue-200 dark:text-blue-900" : "border-zinc-300 dark:border-zinc-600")}>
                      {on && <Check className="size-3" aria-hidden />}
                    </span>
                    <span className={cx("min-w-0 flex-1 truncate", o.count ? "text-zinc-800 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500")} title={o.label}>{o.label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-500">{o.count.toLocaleString("en-US")}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 flex items-center justify-between border-t border-zinc-100 px-1 pt-2 dark:border-zinc-800">
            <button type="button" onClick={() => onChange([])} disabled={!selected.length}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-200 dark:hover:bg-zinc-800">Clear</button>
            <button type="button" onClick={() => { setOpen(false); button.current?.focus(); }}
              className="rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 dark:bg-blue-200 dark:text-blue-900">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The picked values as small chips, each removable, and the button that clears everything. */
export function ActiveFilters({ dims, options, filters, onRemove, onReset, canReset }: {
  dims: Dimension[]; options: Record<string, Option[]>; filters: Partial<Record<string, string[]>>;
  onRemove: (key: Dimension["key"], value: string) => void; onReset: () => void; canReset: boolean;
}) {
  const chips = dims.flatMap((d) => (filters[d.key] ?? []).map((v) => ({ d, v, label: options[d.key]?.find((o) => o.value === v)?.label ?? (v || "Not rated") })));
  if (!chips.length && !canReset) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map(({ d, v, label }) => (
        <span key={`${d.key}:${v}`} className="inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-100 py-0.5 pl-2.5 pr-1 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          <span className="text-zinc-500">{d.label}:</span><span className="truncate">{label}</span>
          <button type="button" onClick={() => onRemove(d.key, v)} aria-label={`Remove ${d.label} ${label}`} className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700"><X className="size-3" /></button>
        </span>
      ))}
      {canReset && (
        <button type="button" onClick={onReset} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-200 dark:hover:bg-zinc-800">
          <RotateCcw className="size-3" aria-hidden />Reset filters
        </button>
      )}
    </div>
  );
}
