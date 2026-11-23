// The Dashboard's time range and filters, kept in the page's address (shareable, and they survive a reload), and the
// shapes of what GET /api/dashboard returns for them.
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

export const DIMENSION_KEYS = ["product", "social_network", "exposure_tag", "sensitive_topic", "kof", "kof_list", "sentiment", "verdict", "source"] as const;
export type DimensionKey = (typeof DIMENSION_KEYS)[number];
export type RangeName = "hour" | "today" | "24h" | "7d" | "30d" | "custom";
export type Filters = Partial<Record<DimensionKey, string[]>>;

export interface Option { value: string; label: string; count: number }
export interface Breakdown extends Option { more?: boolean }
export interface Dimension { key: DimensionKey; label: string; line: string; multi: boolean }
export interface ResponseStep { key: string; label: string; description: string; of: number; avg_s: number | null; median_s: number | null; n: number; recorded_from?: string | null }
export interface AlertLines {
  total_messages: number; total_alerts: number; messages_in_range: number; new_alerts: number; previous_messages: number; capped: boolean;
  breakdowns: Record<DimensionKey, Breakdown[]>; options: Record<DimensionKey, Option[]>; dimensions: Dimension[];
  response_times: ResponseStep[]; filters: Filters;
}

export const RANGES: { value: RangeName; label: string }[] = [
  { value: "today", label: "Today" }, { value: "24h", label: "Last 24 hours" }, { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" }, { value: "custom", label: "Custom" },
];

export interface DashboardQuery { range: RangeName; from: string; to: string; filters: Filters }

/** Today's date (YYYY-MM-DD) in a timezone, `daysBack` days earlier. */
export function localDate(tz: string, daysBack = 0): string {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + 1)).toISOString().slice(0, 10);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_VALUES = new Set<string>(["hour", "today", "24h", "7d", "30d", "custom"]);

/** The range and filters in the address bar, and ways to change them (each change replaces the address, so Back leaves the page). */
export function useDashboardQuery(tz: string) {
  const [params, setParams] = useSearchParams();
  const query = useMemo<DashboardQuery>(() => {
    const range = (RANGE_VALUES.has(params.get("range") ?? "") ? params.get("range") : "today") as RangeName;
    const from = DATE.test(params.get("from") ?? "") ? params.get("from")! : localDate(tz, 7);
    const to = DATE.test(params.get("to") ?? "") ? params.get("to")! : localDate(tz);
    const filters: Filters = {};
    for (const key of DIMENSION_KEYS) {
      const values = params.getAll(key).filter(Boolean);
      if (values.length) filters[key] = Array.from(new Set(values));
    }
    return { range, from, to, filters };
  }, [params, tz]);

  const write = useCallback((next: DashboardQuery) => {
    const out = new URLSearchParams();
    if (next.range !== "today") out.set("range", next.range);
    if (next.range === "custom") { out.set("from", next.from); out.set("to", next.to); }
    for (const key of DIMENSION_KEYS) for (const v of next.filters[key] ?? []) out.append(key, v);
    setParams(out, { replace: true });
  }, [setParams]);

  const setRange = useCallback((range: RangeName) => write({ ...query, range }), [query, write]);
  const setDates = useCallback((from: string, to: string) => write({ ...query, range: "custom", from, to }), [query, write]);
  const setFilter = useCallback((key: DimensionKey, values: string[]) => write({ ...query, filters: { ...query.filters, [key]: values } }), [query, write]);
  const toggle = useCallback((key: DimensionKey, value: string) => {
    const now = query.filters[key] ?? [];
    setFilter(key, now.includes(value) ? now.filter((v) => v !== value) : [...now, value]);
  }, [query, setFilter]);
  const reset = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);
  const filterCount = Object.values(query.filters).reduce((n, vs) => n + (vs?.length ? 1 : 0), 0);
  const customOk = query.range !== "custom" || query.from <= query.to;

  /** What GET /api/dashboard is asked for. Custom days run from midnight to midnight in the display timezone. */
  const apiParams = useMemo(() => ({
    range: query.range,
    from: query.range === "custom" ? `${query.from}T00:00:00` : undefined,
    to: query.range === "custom" ? `${nextDay(query.to)}T00:00:00` : undefined,
    filters: filterCount ? JSON.stringify(query.filters) : undefined,
  }), [query, filterCount]);

  return { query, apiParams, setRange, setDates, setFilter, toggle, reset, filterCount, customOk, isDefault: query.range === "today" && !filterCount };
}
