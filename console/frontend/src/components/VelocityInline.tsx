import { Activity, Bell, BellOff, ExternalLink, RefreshCw, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { apiGet, apiSend } from "../api/client";
import { useApp } from "../context";
import { fmtNum, fmtRelative } from "../lib/format";
import { Badge, Button, cx, Modal } from "./ui";

export interface VelocitySummary {
  key: string;
  platform: string;
  live_poll: boolean;
  url: string;
  author: string;
  author_name: string;
  followers: number | null;
  text: string;
  case_id: string | null;
  alert_name: string;
  product: string;
  published_at: string | null;
  last_polled_at: string | null;
  poll_status: string;
  poll_error: string;
  baseline_engagements: number;
  current_engagements: number;
  likes: number;
  comments: number;
  shares: number;
  delta_engagements: number;
  multiplier: number;
  tier: "steady" | "growing" | "surging" | string;
  tier_label: string;
  tier_reason: string;
  peak_per_hour: number;
  peak_at_hour: number;
  velocity_1h: number;
  velocity_24h: number;
  elapsed_hours: number;
  sparkline: number[];
  snapshot_count: number;
  watched: boolean;
  watcher_count: number;
}

export interface VelocityHourPoint {
  hour: number;
  label: string;
  ts_ms: number;
  cumulative: number;
  hourly: number;
  shares_replies: number;
  shares_replies_total: number;
}

interface LookupOut {
  by_case: Record<string, VelocitySummary>;
  by_url: Record<string, VelocitySummary>;
}

const TIER_TONE: Record<string, "zinc" | "violet" | "rose" | "blue"> = {
  steady: "zinc",
  growing: "violet",
  surging: "rose",
};

const TIER_STROKE: Record<string, string> = {
  steady: "#4285f4",
  growing: "#9b72cb",
  surging: "#d96570",
};

export function VelocitySparkline({ values, tier = "steady", width = 76, height = 22 }: {
  values: number[]; tier?: string; width?: number; height?: number;
}) {
  const pts = values && values.length > 0 ? values : [0, 0];
  const max = Math.max(1, ...pts);
  const coords = pts.map((v, i) => {
    const x = pts.length === 1 ? width / 2 : (i / (pts.length - 1)) * (width - 4) + 2;
    const y = height - 3 - (Math.max(0, v) / max) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block shrink-0 overflow-visible" aria-hidden>
      <polyline fill="none" stroke={TIER_STROKE[tier] ?? "#4285f4"} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" points={coords} />
    </svg>
  );
}

/** Batch-loads velocity summaries for the visible cases/URLs in one request; never blocks or fails the host view. */
export function useVelocityMap({ caseIds = [], urls = [] }: { caseIds?: (string | null | undefined)[]; urls?: (string | null | undefined)[] }) {
  const [data, setData] = useState<LookupOut>({ by_case: {}, by_url: {} });
  const key = useMemo(() => {
    const c = Array.from(new Set(caseIds.filter((x): x is string => !!x))).sort();
    const u = Array.from(new Set(urls.filter((x): x is string => !!x))).sort();
    return JSON.stringify({ c, u });
  }, [caseIds, urls]);

  const reload = useCallback(async () => {
    const { c, u } = JSON.parse(key) as { c: string[]; u: string[] };
    if (c.length === 0 && u.length === 0) return;
    try {
      const res = await apiSend<LookupOut>("post", "/velocity/lookup", { case_ids: c.slice(0, 150), urls: u.slice(0, 150) });
      setData(res);
    } catch {
      /* velocity lookup is supplementary context; never break the host page */
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateOne = useCallback((summary: VelocitySummary) => {
    setData((prev) => ({
      by_case: summary.case_id ? { ...prev.by_case, [summary.case_id]: summary } : prev.by_case,
      by_url: summary.url ? { ...prev.by_url, [summary.url]: summary } : prev.by_url,
    }));
  }, []);

  const find = useCallback((caseId?: string | null, url?: string | null): VelocitySummary | null => {
    if (caseId && data.by_case[caseId]) return data.by_case[caseId];
    if (url) {
      if (data.by_url[url]) return data.by_url[url];
      const norm = url.replace(/\/+$/, "").toLowerCase();
      for (const [k, v] of Object.entries(data.by_url)) {
        if (k.replace(/\/+$/, "").toLowerCase() === norm) return v;
      }
    }
    return null;
  }, [data]);

  return { find, reload, updateOne };
}

function canPollUrl(url?: string | null): boolean {
  if (!url) return false;
  return /^https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com|bsky\.app)\//i.test(url.trim());
}

/**
 * Compact velocity chip for Review feed, Cases, Stories, Early Detection and Temp check.
 * Shows the post's traction tier, growth since the alert and mini sparkline; clicking opens a quick 7-day curve modal
 * with live refresh and "Watch spikes".
 */
export function VelocityBadge({ summary: initial, caseId, postUrl, compact = false, onUpdated }: {
  summary?: VelocitySummary | null;
  caseId?: string | null;
  postUrl?: string | null;
  compact?: boolean;
  onUpdated?: (s: VelocitySummary) => void;
}) {
  const { me, toast } = useApp();
  const [summary, setSummary] = useState<VelocitySummary | null>(initial ?? null);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState<VelocityHourPoint[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial) setSummary(initial);
  }, [initial]);

  const canAct = Boolean(me && ["analyst", "im", "lead", "admin"].includes(me.role));
  const pollable = summary?.live_poll ?? canPollUrl(postUrl);

  const checkNow = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canAct) return;
    setBusy(true);
    try {
      const res = await apiSend<{ post: VelocitySummary }>("post", "/velocity/track", {
        url: postUrl || summary?.url || "",
        case_id: caseId || summary?.case_id || "",
        poll: true,
      });
      setSummary(res.post);
      onUpdated?.(res.post);
      const detail = await apiGet<{ post: VelocitySummary; hours: VelocityHourPoint[] }>(`/velocity/posts/${res.post.key}`);
      setHours(detail.hours);
      setOpen(true);
    } catch (err) {
      toast((err as { message?: string })?.message || "Could not check velocity for this post", "error");
    } finally {
      setBusy(false);
    }
  };

  const openModal = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!summary) return;
    setOpen(true);
    if (!hours) {
      try {
        const detail = await apiGet<{ post: VelocitySummary; hours: VelocityHourPoint[] }>(`/velocity/posts/${summary.key}`);
        setSummary(detail.post);
        setHours(detail.hours);
      } catch {
        /* keep summary */
      }
    }
  };

  const refreshLive = async () => {
    if (!summary || !canAct) return;
    setBusy(true);
    try {
      const detail = await apiSend<{ post: VelocitySummary; hours: VelocityHourPoint[] }>("post", `/velocity/posts/${summary.key}/refresh`);
      setSummary(detail.post);
      setHours(detail.hours);
      onUpdated?.(detail.post);
      toast("Updated live post counts", "success");
    } catch (err) {
      toast((err as { message?: string })?.message || "Refresh failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleWatch = async () => {
    if (!summary || !canAct) return;
    setBusy(true);
    try {
      const res = await apiSend<{ post: VelocitySummary }>("post", `/velocity/posts/${summary.key}/watch`, { watch: !summary.watched });
      setSummary(res.post);
      onUpdated?.(res.post);
      toast(res.post.watched ? "Watching for velocity spikes" : "Stopped watching spikes", "success");
    } catch (err) {
      toast((err as { message?: string })?.message || "Could not update spike alert", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!summary) {
    if (!pollable || !canAct) return null;
    return (
      <button
        type="button"
        onClick={(e) => void checkNow(e)}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600 transition-colors hover:border-blue-300 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300 dark:hover:text-blue-300"
        title="Fetch live engagement velocity (T+0 to T+168h)"
      >
        <TrendingUp className={cx("size-3", busy && "animate-pulse")} aria-hidden />
        {busy ? "Checking…" : "Check velocity"}
      </button>
    );
  }

  const tone = TIER_TONE[summary.tier] ?? "zinc";
  const rateText = summary.peak_per_hour > 0
    ? `${fmtNum(summary.peak_per_hour)}/hr`
    : summary.delta_engagements > 0
      ? `+${fmtNum(summary.delta_engagements)}`
      : `${fmtNum(summary.current_engagements)} eng`;

  return (
    <>
      <button
        type="button"
        onClick={(e) => void openModal(e)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        title={`${summary.tier_label} velocity · ${summary.tier_reason}. Click for 7-day curve.`}
      >
        <Badge tone={tone}>
          <Activity className="size-3 shrink-0" aria-hidden />
          {summary.tier_label} · {rateText}
        </Badge>
        {!compact && summary.sparkline.length > 1 && <VelocitySparkline values={summary.sparkline} tier={summary.tier} width={56} height={18} />}
      </button>

      <Modal
        open={open}
        wide
        title={`Post velocity · ${summary.author ? `@${summary.author}` : summary.platform.toUpperCase()}`}
        onClose={() => setOpen(false)}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Link to={`/velocity?focus=${encodeURIComponent(summary.key)}`} onClick={() => setOpen(false)} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-300">
              Open in Post velocity →
            </Link>
            <div className="flex items-center gap-2">
              {canAct && (
                <Button size="sm" icon={summary.watched ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />} loading={busy} onClick={() => void toggleWatch()}>
                  {summary.watched ? "Watching spikes" : "Watch spikes"}
                </Button>
              )}
              {canAct && summary.live_poll && (
                <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void refreshLive()}>
                  Refresh live counts
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{summary.tier_label}</Badge>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{summary.tier_reason}</span>
            {summary.last_polled_at && <span className="ml-auto text-xs text-zinc-400">Checked {fmtRelative(summary.last_polled_at)}</span>}
          </div>
          {summary.text && <p className="rounded-xl bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200">{summary.text}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500">Current engagements</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{fmtNum(summary.current_engagements)}</p>
              <p className="text-xs text-zinc-400">Baseline {fmtNum(summary.baseline_engagements)}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500">Growth since alert</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">+{fmtNum(summary.delta_engagements)}</p>
              <p className="text-xs text-zinc-400">{summary.multiplier.toFixed(2)}x baseline</p>
            </div>
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500">Peak hourly spike</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{fmtNum(summary.peak_per_hour)}/hr</p>
              <p className="text-xs text-zinc-400">at T+{summary.peak_at_hour}h</p>
            </div>
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500">Last hour</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{fmtNum(summary.velocity_1h)}/hr</p>
              <p className="text-xs text-zinc-400">24h: +{fmtNum(summary.velocity_24h)}</p>
            </div>
          </div>
          {hours && hours.length > 1 && (
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="mb-2 text-xs font-medium text-zinc-500">Hourly velocity curve (T+0 to T+{hours[hours.length - 1]?.hour ?? 0}h)</p>
              <VelocitySparkline values={hours.map((h) => h.hourly)} tier={summary.tier} width={520} height={64} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4 text-xs">
            {summary.url && (
              <a href={summary.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-300">
                Open post <ExternalLink className="size-3" />
              </a>
            )}
            {summary.author && (
              <Link to={`/temp-check?q=${encodeURIComponent(summary.author)}`} onClick={() => setOpen(false)} className="font-medium text-blue-600 hover:underline dark:text-blue-300">
                Run a Temp check on @{summary.author} →
              </Link>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
