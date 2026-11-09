import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { useApp } from "../context";
import { fmtBucket, fmtNum, truncate } from "../lib/format";
import { CHART_COLORS } from "../lib/labels";

function useChartTheme() {
  const { theme } = useApp();
  const dark = theme === "dark";
  return {
    grid: dark ? "#27272a" : "#f4f4f5",
    axis: dark ? "#a1a1aa" : "#71717a",
    tooltip: {
      backgroundColor: dark ? "rgba(24, 24, 27, 0.96)" : "rgba(255, 255, 255, 0.97)",
      border: `1px solid ${dark ? "#3f3f46" : "#e4e4e7"}`,
      borderRadius: 8,
      fontSize: 12,
      color: dark ? "#fafafa" : "#0f172a",
      boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)",
    },
  };
}

export interface BarDatum { label: string; value: number; hint?: string }

/** Horizontal bars, largest first (e.g. corrections by field). */
export function BarList({ data, color = CHART_COLORS[0], height, labelWidth = 170, valueLabel = "Count" }: {
  data: BarDatum[]; color?: string; height?: number; labelWidth?: number; valueLabel?: string;
}) {
  const t = useChartTheme();
  const rows = [...data].sort((a, b) => b.value - a.value);
  const h = height ?? Math.max(120, rows.length * 30 + 24);
  if (!rows.length) return <p className="py-8 text-center text-sm text-zinc-500">No data in this window.</p>;
  return (
    <div style={{ height: h }} role="img" aria-label={`${valueLabel} by category`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 28, bottom: 4, left: 4 }}>
          <CartesianGrid horizontal={false} stroke={t.grid} />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: t.axis }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={labelWidth} tick={{ fontSize: 12, fill: t.axis }} axisLine={false} tickLine={false}
            tickFormatter={(v: string) => truncate(v, Math.floor(labelWidth / 7))} />
          <Tooltip cursor={{ fill: t.grid }} contentStyle={t.tooltip} formatter={(v) => [fmtNum(Number(v)), valueLabel]} />
          <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} maxBarSize={22} label={{ position: "right", fontSize: 11, fill: t.axis }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface Series { key: string; label: string; color: string }

/** Stacked daily/hourly counts per event type. */
export function TimeseriesChart({ rows, series, height = 300, stacked = true }: {
  rows: Record<string, string | number>[]; series: Series[]; height?: number; stacked?: boolean;
}) {
  const t = useChartTheme();
  if (!rows.length) return <p className="py-8 text-center text-sm text-zinc-500">No data in this window.</p>;
  return (
    <div style={{ height }} role="img" aria-label="Events over time">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`g-${s.key.replace(/\W/g, "")}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={s.color} stopOpacity={0.35} />
                <stop offset="95%" stopColor={s.color} stopOpacity={0.03} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke={t.grid} />
          <XAxis dataKey="bucket" tickFormatter={(v: string) => fmtBucket(v)} tick={{ fontSize: 11, fill: t.axis }} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: t.axis }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={t.tooltip} labelFormatter={(v) => fmtBucket(String(v))} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stackId={stacked ? "1" : undefined} stroke={s.color} strokeWidth={1.75}
              fill={`url(#g-${s.key.replace(/\W/g, "")})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Grouped bars for a few categories (e.g. SLA met/missed by tier). */
export function GroupedBars({ data, series, height = 220 }: { data: Record<string, string | number>[]; series: Series[]; height?: number }) {
  const t = useChartTheme();
  if (!data.length) return <p className="py-8 text-center text-sm text-zinc-500">No data in this window.</p>;
  return (
    <div style={{ height }} role="img" aria-label="Grouped comparison">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid vertical={false} stroke={t.grid} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: t.axis }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: t.axis }} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: t.grid }} contentStyle={t.tooltip} />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
          {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={36} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DonutChart({ data, height = 220 }: { data: { name: string; value: number }[]; height?: number }) {
  const t = useChartTheme();
  const rows = data.filter((d) => d.value > 0);
  if (!rows.length) return <p className="py-8 text-center text-sm text-zinc-500">No data in this window.</p>;
  return (
    <div style={{ height }} role="img" aria-label="Share by category">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="none">
            {rows.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip contentStyle={t.tooltip} formatter={(v) => fmtNum(Number(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} layout="vertical" align="right" verticalAlign="middle" />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
