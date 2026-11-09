// Display formatting. Times render in the agent's display timezone (config.timezone, from /api/me).

let displayTz = "America/New_York";

export function setDisplayTimezone(tz: string): void {
  displayTz = tz || displayTz;
}

export function tzAbbr(): string {
  return ({ "America/New_York": "ET", "America/Los_Angeles": "PT", "America/Chicago": "CT", UTC: "UTC" } as Record<string, string>)[displayTz] ?? displayTz;
}

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${key}|${displayTz}`;
  let f = cache.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: displayTz, ...opts });
    cache.set(id, f);
  }
  return f;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 12, 2026, 2:05 PM" */
export function fmtDateTime(value: string | null | undefined): string {
  const d = toDate(value);
  return d ? formatter("dt", { month: "short", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d) : "—";
}

/** "Oct 12, 2026" */
export function fmtDate(value: string | null | undefined): string {
  const d = toDate(value);
  return d ? formatter("d", { month: "short", day: "2-digit", year: "numeric" }).format(d) : "—";
}

/** "2:05 PM" */
export function fmtTime(value: string | null | undefined): string {
  const d = toDate(value);
  return d ? formatter("t", { hour: "numeric", minute: "2-digit" }).format(d) : "—";
}

/** "Mon, Oct 12" */
export function fmtDay(value: string | Date): string {
  const d = toDate(value);
  return d ? formatter("day", { weekday: "short", month: "short", day: "numeric" }).format(d) : "—";
}

/** Short label for chart buckets ("2026-10-12" -> "Oct 12"). */
export function fmtBucket(bucket: string): string {
  const [datePart, timePart] = bucket.split("T");
  const [y, m, day] = datePart.split("-").map(Number);
  const month = new Date(Date.UTC(y, (m || 1) - 1, day || 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return timePart ? `${month} ${day} ${timePart.slice(0, 5)}` : `${month} ${day}`;
}

/** "5 min ago" / "in 3 h" */
export function fmtRelative(value: string | null | undefined, now: number = Date.now()): string {
  const d = toDate(value);
  if (!d) return "—";
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const text = abs < 45 ? "just now" : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86_400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86_400)} d`;
  if (text === "just now") return text;
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const s = Math.abs(seconds);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86_400).toFixed(1)} d`;
}

export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  return fmtDuration(minutes * 60);
}

export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined || Number.isNaN(n) ? "—" : n.toLocaleString("en-US");
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function fmtPct(x: number | null | undefined, digits = 0): string {
  return x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`;
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return fmtNum(v);
  if (Array.isArray(v)) return v.length ? v.map(fmtValue).join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function titleCase(s: string): string {
  return s.replace(/[_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
