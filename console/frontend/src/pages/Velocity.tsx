import { Activity, Bell, BellOff, Download, ExternalLink, Layers, Plus, RefreshCw, Search, Trash2, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ReTooltip, XAxis, YAxis } from "recharts";

import { apiGet, apiSend } from "../api/client";
import { useApi } from "../api/hooks";
import { Alert, Badge, Button, Card, Drawer, EmptyState, ErrorState, Input, Modal, OffNotice, PageHeader, Segmented, Select, Spinner, Stat, Tabs, TD, TH, Toggle, TR } from "../components/ui";
import { VelocitySparkline, type VelocityHourPoint, type VelocitySummary } from "../components/VelocityInline";
import { useApp } from "../context";
import { fmtDateTime, fmtNum, fmtRelative } from "../lib/format";

interface VelocityListOut {
  posts: VelocitySummary[];
  counts: { total: number; surging: number; growing: number; steady: number; peak_today: number };
  switch: boolean;
  can_edit: boolean;
  is_admin: boolean;
  last_run: { at?: string; polled?: number; succeeded?: number } | null;
}

interface DetailOut {
  post: VelocitySummary;
  hours: VelocityHourPoint[];
  snapshots: { ts: number; engagements: number; likes: number; comments: number; shares: number }[];
  watchers: string[];
}

interface CompareOut {
  window_hours: number;
  max_hours: number;
  series: { post: VelocitySummary; hours: VelocityHourPoint[] }[];
}

interface LegacyPreview {
  dry_run: boolean;
  added: { key: string; url: string; author: string }[];
  updated: { key: string; url: string; author: string }[];
  skipped: { url: string; reason: string }[];
  note?: string;
}

type MetricKey = "hourly" | "cumulative" | "shares_replies";
type WindowHours = 24 | 48 | 168;

// Google & Gemini brand palette only — zero yellow/orange/amber.
const SERIES_COLORS = ["#4285f4", "#9b72cb", "#d96570", "#34a853", "#60a5fa", "#c084fc"];

const TIER_TONE: Record<string, "zinc" | "violet" | "rose"> = {
  steady: "zinc",
  growing: "violet",
  surging: "rose",
};

export default function VelocityPage() {
  const { toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<"leaderboard" | "compare">("leaderboard");
  const [tier, setTier] = useState<string>("");
  const [platform, setPlatform] = useState<string>("");
  const [sort, setSort] = useState<string>("peak");
  const [watchedOnly, setWatchedOnly] = useState(false);
  const [q, setQ] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [watchOnAdd, setWatchOnAdd] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [metric, setMetric] = useState<MetricKey>("hourly");
  const [win, setWin] = useState<WindowHours>(168);

  const [activeKey, setActiveKey] = useState<string | null>(params.get("focus"));
  const [detail, setDetail] = useState<DetailOut | null>(null);
  const [compareData, setCompareData] = useState<CompareOut | null>(null);
  const [importModal, setImportModal] = useState(false);
  const [importPreview, setImportPreview] = useState<LegacyPreview | null>(null);

  const list = useApi<VelocityListOut>("/velocity", { sort, tier, platform, q, watched: watchedOnly || undefined }, 45_000);

  useEffect(() => {
    const f = params.get("focus");
    if (f) setActiveKey(f);
  }, [params]);

  useEffect(() => {
    if (!activeKey) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    apiGet<DetailOut>(`/velocity/posts/${activeKey}`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [activeKey]);

  useEffect(() => {
    if (selected.length < 2) {
      setCompareData(null);
      return;
    }
    let cancelled = false;
    apiGet<CompareOut>("/velocity/compare", { keys: selected.join(","), window: win })
      .then((d) => { if (!cancelled) setCompareData(d); })
      .catch(() => { if (!cancelled) setCompareData(null); });
    return () => { cancelled = true; };
  }, [selected, win]);

  const addPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    setBusy("track");
    try {
      const res = await apiSend<{ post: VelocitySummary }>("post", "/velocity/track", { url: urlInput.trim(), poll: true, watch: watchOnAdd });
      setUrlInput("");
      toast(`Tracking @${res.post.author || res.post.platform}`, "success");
      list.reload();
      setActiveKey(res.post.key);
    } catch (err) {
      toast((err as { message?: string })?.message || "Could not track that post link", "error");
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    setBusy("refresh");
    try {
      const res = await apiSend<{ polled: number; succeeded: number }>("post", "/velocity/refresh");
      toast(`Checked ${res.polled} post${res.polled === 1 ? "" : "s"} (${res.succeeded} live)`, "success");
      list.reload();
      if (activeKey) {
        const d = await apiGet<DetailOut>(`/velocity/posts/${activeKey}`);
        setDetail(d);
      }
    } catch (err) {
      toast((err as { message?: string })?.message || "Refresh failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const toggleWatch = async (p: VelocitySummary) => {
    setBusy(p.key);
    try {
      const res = await apiSend<{ post: VelocitySummary }>("post", `/velocity/posts/${p.key}/watch`, { watch: !p.watched });
      toast(res.post.watched ? "Watching for velocity spikes" : "Stopped watching spikes", "success");
      list.reload();
      if (detail?.post.key === p.key) setDetail({ ...detail, post: res.post });
    } catch (err) {
      toast((err as { message?: string })?.message || "Could not change watch setting", "error");
    } finally {
      setBusy(null);
    }
  };

  const removePost = async (p: VelocitySummary) => {
    if (!window.confirm(`Stop tracking velocity for ${p.author ? `@${p.author}` : p.url}?`)) return;
    setBusy(p.key);
    try {
      await apiSend("delete", `/velocity/posts/${p.key}`);
      setSelected((prev) => prev.filter((k) => k !== p.key));
      if (activeKey === p.key) setActiveKey(null);
      toast("Removed from tracking", "success");
      list.reload();
    } catch (err) {
      toast((err as { message?: string })?.message || "Remove failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const toggleCompare = (key: string) => {
    setSelected((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : prev.length >= 6 ? prev : [...prev, key]);
  };

  const previewLegacy = async () => {
    setImportModal(true);
    setBusy("import-preview");
    try {
      const res = await apiSend<LegacyPreview>("post", "/velocity/import-legacy", { dry_run: true });
      setImportPreview(res);
    } catch (err) {
      toast((err as { message?: string })?.message || "Could not read legacy tracker storage", "error");
      setImportModal(false);
    } finally {
      setBusy(null);
    }
  };

  const applyLegacy = async () => {
    setBusy("import-apply");
    try {
      const res = await apiSend<LegacyPreview>("post", "/velocity/import-legacy", { dry_run: false });
      toast(`Imported ${res.added.length} new and updated ${res.updated.length} tracked posts`, "success");
      setImportModal(false);
      setImportPreview(null);
      list.reload();
    } catch (err) {
      toast((err as { message?: string })?.message || "Import failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const detailChartRows = useMemo(() => {
    if (!detail) return [];
    return detail.hours.filter((h) => h.hour <= win);
  }, [detail, win]);

  const compareRows = useMemo(() => {
    if (!compareData || compareData.series.length < 2) return [];
    const rows: Record<string, number | string>[] = [];
    for (let h = 0; h <= compareData.window_hours; h += 1) {
      let any = false;
      const row: Record<string, number | string> = { hour: h, label: `T+${h}h` };
      compareData.series.forEach((s) => {
        const pt = s.hours.find((x) => x.hour === h);
        if (pt) {
          row[s.post.key] = pt[metric];
          any = true;
        }
      });
      if (any) rows.push(row);
    }
    return rows;
  }, [compareData, metric]);

  if (list.loading && !list.data) return <Spinner label="Loading post velocity…" />;
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const d = list.data!;

  return (
    <div>
      <PageHeader
        title="Post velocity"
        description="Track how fast X and Bluesky posts gain engagements over their first 7 days (T+0 to T+168h), compare viral curves side by side, and watch posts for sudden spikes."
        actions={
          <>
            {d.is_admin && (
              <Button size="sm" icon={<Download className="size-3.5" />} loading={busy === "import-preview"} onClick={() => void previewLegacy()}>
                Bring over legacy tracker
              </Button>
            )}
            <Button icon={<RefreshCw className="size-4" />} disabled={!d.can_edit} loading={busy === "refresh"} onClick={() => void refreshAll()}>
              Refresh live counts
            </Button>
          </>
        }
      />

      {!d.switch && (
        <OffNotice what="Background velocity polling & spike alerts" flag="velocity_tracking">
          Analysts can still paste any post below or click <strong>Check velocity</strong> on an alert to pull live numbers right now.
        </OffNotice>
      )}

      {d.can_edit && (
        <Card className="mb-5" title="Track a post" subtitle="Paste an X (x.com) or Bluesky (bsky.app) post link to fetch its live engagements and start its 7-day curve. Alerts with post links are added automatically.">
          <form onSubmit={(e) => void addPost(e)} className="flex flex-wrap items-center gap-3">
            <div className="min-w-64 flex-1">
              <Input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://x.com/handle/status/1234567890123456789 or https://bsky.app/profile/handle/post/abc123"
                aria-label="Post URL to track"
              />
            </div>
            <Toggle checked={watchOnAdd} onChange={setWatchOnAdd} label="Alert me on spikes" />
            <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={busy === "track"}>
              Track post
            </Button>
          </form>
        </Card>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Surging now" value={fmtNum(d.counts.surging)} tone={d.counts.surging > 0 ? "rose" : undefined} glow={d.counts.surging > 0} hint="10k+ jump or 5x spike" onClick={() => setTier(tier === "surging" ? "" : "surging")} />
        <Stat label="Growing" value={fmtNum(d.counts.growing)} tone={d.counts.growing > 0 ? "violet" : undefined} hint="1,000+ or 1.35x baseline" onClick={() => setTier(tier === "growing" ? "" : "growing")} />
        <Stat label="Tracked posts" value={fmtNum(d.counts.total)} hint="7-day window (T+0 to T+168h)" onClick={() => setTier("")} />
        <Stat label="Highest hourly spike" value={`${fmtNum(d.counts.peak_today)}/hr`} tone="blue" hint={d.last_run?.at ? `Last check ${fmtRelative(d.last_run.at)}` : "On-demand checks ready"} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "leaderboard", label: "Velocity leaderboard", count: d.posts.length },
          { key: "compare", label: "Compare curves (T+0…T+168h)", count: selected.length },
        ]}
      />

      {tab === "compare" ? (
        <Card
          title="Side-by-side post trajectory"
          subtitle="Every selected post is lined up from the moment it was published (T+0h), regardless of what day it went live."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<MetricKey>
                label="Metric"
                value={metric}
                onChange={setMetric}
                options={[
                  { value: "hourly", label: "Hourly velocity (/hr)" },
                  { value: "cumulative", label: "Total engagements" },
                  { value: "shares_replies", label: "Reposts & replies" },
                ]}
              />
              <Segmented<WindowHours>
                label="Window"
                value={win}
                onChange={setWin}
                options={[
                  { value: 24, label: "24h" },
                  { value: 48, label: "48h" },
                  { value: 168, label: "7 days" },
                ]}
              />
            </div>
          }
        >
          {selected.length < 2 ? (
            <EmptyState icon={<Layers className="size-8" />} title="Pick at least two posts to compare">
              Tick the <strong>Compare</strong> box on two to six posts in the Velocity leaderboard tab to overlay their T+0…T+168h curves here.
            </EmptyState>
          ) : !compareData ? (
            <Spinner label="Building comparison curves…" />
          ) : (
            <div className="space-y-4">
              <div className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={compareRows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <ReTooltip />
                    <Legend />
                    {compareData.series.map((s, idx) => (
                      <Line
                        key={s.post.key}
                        type="monotone"
                        dataKey={s.post.key}
                        name={s.post.author ? `@${s.post.author} (${s.post.tier_label})` : s.post.key}
                        stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                        strokeWidth={2.25}
                        dot={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {compareData.series.map((s) => (
                  <Badge key={s.post.key} tone={TIER_TONE[s.post.tier] ?? "zinc"}>
                    @{s.post.author || s.post.platform} · peak {fmtNum(s.post.peak_per_hour)}/hr at T+{s.post.peak_at_hour}h
                  </Badge>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear selection</Button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Card
          padded={false}
          title="Tracked posts"
          subtitle="Click any row to open its full 7-day curve and hourly breakdown. Tick Compare on two or more rows to overlay them."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-52">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-zinc-400" aria-hidden />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search author, text, alert…" className="py-1.5 pl-8 text-xs" />
              </div>
              <Select value={tier} onChange={(e) => setTier(e.target.value)} className="w-36 py-1.5 text-xs" aria-label="Filter by traction">
                <option value="">All traction</option>
                <option value="surging">Surging</option>
                <option value="growing">Growing</option>
                <option value="steady">Steady</option>
              </Select>
              <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-32 py-1.5 text-xs" aria-label="Filter by platform">
                <option value="">All platforms</option>
                <option value="x">X</option>
                <option value="bluesky">Bluesky</option>
              </Select>
              <Select value={sort} onChange={(e) => setSort(e.target.value)} className="w-40 py-1.5 text-xs" aria-label="Sort posts">
                <option value="peak">Sort: Peak / hr</option>
                <option value="velocity_1h">Sort: Last hour</option>
                <option value="total">Sort: Total engagements</option>
                <option value="recent">Sort: Newest</option>
              </Select>
              <Toggle checked={watchedOnly} onChange={setWatchedOnly} label="Watched" />
              {selected.length >= 2 && (
                <Button size="sm" variant="primary" onClick={() => setTab("compare")}>
                  Compare ({selected.length})
                </Button>
              )}
            </div>
          }
        >
          {d.posts.length === 0 ? (
            <EmptyState icon={<TrendingUp className="size-8" />} title="No tracked posts match this view">
              Paste an X or Bluesky post link above to start tracking its 7-day velocity curve.
            </EmptyState>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>Compare</th>
                  <th className={TH}>Traction</th>
                  <th className={TH}>Post & alert</th>
                  <th className={TH}>Engagements</th>
                  <th className={TH}>Peak spike</th>
                  <th className={TH}>7d curve</th>
                  <th className={TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {d.posts.map((p) => (
                  <tr key={p.key} className={TR} onClick={() => { setActiveKey(p.key); setParams({ focus: p.key }, { replace: true }); }}>
                    <td className={TD} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Compare ${p.author || p.key}`}
                        className="size-4 rounded accent-blue-600"
                        checked={selected.includes(p.key)}
                        onChange={() => toggleCompare(p.key)}
                      />
                    </td>
                    <td className={TD}>
                      <Badge tone={TIER_TONE[p.tier] ?? "zinc"}>
                        <Activity className="size-3" aria-hidden />
                        {p.tier_label}
                      </Badge>
                      <span className="mt-1 block text-xs text-zinc-400">T+{p.elapsed_hours}h</span>
                    </td>
                    <td className={TD}>
                      <div className="max-w-md">
                        <div className="flex flex-wrap items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                          <span>{p.author ? `@${p.author}` : p.platform.toUpperCase()}</span>
                          <span className="text-xs font-normal uppercase text-zinc-400">· {p.platform}</span>
                          {p.case_id && (
                            <Link
                              to={`/feed/${p.case_id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 hover:underline dark:bg-blue-900/30 dark:text-blue-200"
                            >
                              {p.case_id}
                            </Link>
                          )}
                          {p.product && <span className="text-xs font-normal text-zinc-500">· {p.product}</span>}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{p.text || p.alert_name || p.url}</p>
                        {p.poll_error && <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-400">{p.poll_error}</p>}
                      </div>
                    </td>
                    <td className={TD}>
                      <span className="font-semibold tabular-nums">{fmtNum(p.current_engagements)}</span>
                      <span className="block text-xs tabular-nums text-zinc-500">
                        +{fmtNum(p.delta_engagements)} ({p.multiplier.toFixed(2)}x)
                      </span>
                    </td>
                    <td className={TD}>
                      <span className="font-semibold tabular-nums">{fmtNum(p.peak_per_hour)}/hr</span>
                      <span className="block text-xs text-zinc-500">at T+{p.peak_at_hour}h · now {fmtNum(p.velocity_1h)}/hr</span>
                    </td>
                    <td className={TD}>
                      <VelocitySparkline values={p.sparkline} tier={p.tier} width={88} height={24} />
                    </td>
                    <td className={TD} onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        {d.can_edit && (
                          <Button
                            size="sm"
                            variant={p.watched ? "primary" : "secondary"}
                            icon={p.watched ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
                            loading={busy === p.key}
                            onClick={() => void toggleWatch(p)}
                            title={p.watched ? "Watching for velocity spikes" : "Alert me when this post spikes"}
                          >
                            {p.watched ? "Watching" : "Watch"}
                          </Button>
                        )}
                        {p.author && (
                          <Link to={`/temp-check?q=${encodeURIComponent(p.author)}`} className="rounded-full px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-zinc-800">
                            Temp check
                          </Link>
                        )}
                        {d.can_edit && (
                          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void removePost(p)} aria-label="Stop tracking" />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Drawer
        open={!!activeKey}
        onClose={() => { setActiveKey(null); setParams({}, { replace: true }); }}
        title={
          detail ? (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
                  {detail.post.author ? `@${detail.post.author}` : detail.post.platform.toUpperCase()}
                </span>
                <Badge tone={TIER_TONE[detail.post.tier] ?? "zinc"}>{detail.post.tier_label}</Badge>
                {detail.post.case_id && (
                  <Link to={`/feed/${detail.post.case_id}`} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-300">
                    Alert {detail.post.case_id} →
                  </Link>
                )}
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">{detail.post.tier_reason}</p>
            </div>
          ) : "Post trajectory"
        }
        actions={
          detail && d.can_edit ? (
            <Button
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              loading={busy === "drawer-refresh"}
              onClick={async () => {
                setBusy("drawer-refresh");
                try {
                  const updated = await apiSend<DetailOut>("post", `/velocity/posts/${detail.post.key}/refresh`);
                  setDetail(updated);
                  list.reload();
                  toast("Updated live counts", "success");
                } catch (err) {
                  toast((err as { message?: string })?.message || "Refresh failed", "error");
                } finally {
                  setBusy(null);
                }
              }}
            >
              Refresh
            </Button>
          ) : undefined
        }
      >
        {!detail ? (
          <Spinner label="Loading 7-day curve…" />
        ) : (
          <div className="space-y-4">
            {detail.post.text && (
              <Card title="Post text" subtitle={detail.post.published_at ? `Published ${fmtDateTime(detail.post.published_at)}` : undefined}>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{detail.post.text}</p>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
                  {detail.post.url && (
                    <a href={detail.post.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-300">
                      Open original post <ExternalLink className="size-3" />
                    </a>
                  )}
                  {detail.post.author && (
                    <Link to={`/temp-check?q=${encodeURIComponent(detail.post.author)}`} className="font-medium text-blue-600 hover:underline dark:text-blue-300">
                      Run Temp check for @{detail.post.author} →
                    </Link>
                  )}
                </div>
              </Card>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Current" value={fmtNum(detail.post.current_engagements)} hint={`Baseline ${fmtNum(detail.post.baseline_engagements)}`} />
              <Stat label="Growth" value={`+${fmtNum(detail.post.delta_engagements)}`} tone={detail.post.tier === "surging" ? "rose" : detail.post.tier === "growing" ? "violet" : undefined} hint={`${detail.post.multiplier.toFixed(2)}x baseline`} />
              <Stat label="Peak / hr" value={fmtNum(detail.post.peak_per_hour)} tone="blue" hint={`at T+${detail.post.peak_at_hour}h`} />
              <Stat label="Breakdown" value={fmtNum(detail.post.likes)} hint={`likes · ${fmtNum(detail.post.shares)} reposts · ${fmtNum(detail.post.comments)} replies`} />
            </div>

            <Card
              title="Trajectory curve (T+0 to T+168h)"
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented<MetricKey>
                    label="Curve metric"
                    value={metric}
                    onChange={setMetric}
                    options={[
                      { value: "hourly", label: "Hourly (/hr)" },
                      { value: "cumulative", label: "Cumulative" },
                      { value: "shares_replies", label: "Reposts & replies" },
                    ]}
                  />
                  <Segmented<WindowHours>
                    label="Window"
                    value={win}
                    onChange={setWin}
                    options={[
                      { value: 24, label: "24h" },
                      { value: 48, label: "48h" },
                      { value: 168, label: "7d" },
                    ]}
                  />
                </div>
              }
            >
              {detailChartRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">No snapshots recorded yet. Press Refresh to poll live counts.</p>
              ) : (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={detailChartRows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <ReTooltip />
                      <Line
                        type="monotone"
                        dataKey={metric}
                        name={metric === "hourly" ? "Engagements / hr" : metric === "cumulative" ? "Total engagements" : "Reposts & replies / hr"}
                        stroke={detail.post.tier === "surging" ? "#d96570" : detail.post.tier === "growing" ? "#9b72cb" : "#4285f4"}
                        strokeWidth={2.5}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>
        )}
      </Drawer>

      <Modal
        open={importModal}
        wide
        title="Bring over posts from the legacy velocity tracker"
        onClose={() => setImportModal(false)}
        footer={
          <>
            <Button onClick={() => setImportModal(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === "import-apply"} disabled={!importPreview || (importPreview.added.length === 0 && importPreview.updated.length === 0)} onClick={() => void applyLegacy()}>
              Import now
            </Button>
          </>
        }
      >
        {!importPreview ? (
          <Spinner label="Reading legacy tracker file…" />
        ) : (
          <div className="space-y-3 text-sm">
            {importPreview.note && <Alert tone="blue">{importPreview.note}</Alert>}
            <p className="text-zinc-700 dark:text-zinc-300">
              Found <strong>{importPreview.added.length}</strong> new post{importPreview.added.length === 1 ? "" : "s"} to add and{" "}
              <strong>{importPreview.updated.length}</strong> existing post{importPreview.updated.length === 1 ? "" : "s"} whose snapshot history will be merged.
              Nothing in the legacy tool is modified or deleted.
            </p>
            {importPreview.skipped.length > 0 && (
              <p className="text-xs text-zinc-500">{importPreview.skipped.length} entries skipped (unsupported or empty links).</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
