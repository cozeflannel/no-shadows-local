import { ExternalLink, Pause, Play, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { useApi } from "../api/hooks";
import { Badge, Button, Card, cx, EmptyState, ErrorState, PageHeader, Segmented, Spinner, StatusBadge, TD, TH, TR } from "../components/ui";
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import { bounds, pack, packInside, type Circle } from "../lib/pack";

interface Sub { key: string; name: string; alerts: number; engagement: number; first_at: string; last_at: string }
interface Point { t: string; e: number; s: number; id: string }
interface Story {
  story_id: string; title: string; tag: string; product: string; first_at: string; last_at: string; alerts: number; engagement: number; size: number;
  status: "new" | "growing" | "quiet"; needs: number; platforms: string[]; by_meaning: boolean; sub: Sub[]; points: Point[];
  growth: { t: string; alerts: number; engagement: number }[];
}
interface StoriesResponse {
  stories: Story[]; hours: number; since: string; as_of: string; size_by: "engagement" | "alerts"; active_hours: number; by_meaning: boolean;
  totals: { stories: number; alerts: number; engagement: number; growing: number; needs: number };
}
interface StoryAlert {
  case_id: string; alert_name: string | null; status: string; platform: string | null; engagement_total: number | null; post_url: string | null;
  author: string | null; issue_name: string | null; needs: string; at: string; how: "lead" | "meaning" | "words"; sim: number | null; also: string[];
}
interface ChatRow { activity_id: string; ts: string; direction: string; actor: string; actor_name: string | null; text: string; link: string | null; case_id: string | null }
interface StoryDetail { story: Story; alerts: StoryAlert[]; chat: ChatRow[]; shown: number; total: number }

const ON_MAP = 120;
const STATUS: Record<Story["status"], { label: string; ring: string; fill: string; dot: string; tone: "blue" | "violet" | "zinc" }> = {
  growing: { label: "Growing", ring: "stroke-blue-600 dark:stroke-blue-300", fill: "fill-blue-500/15 dark:fill-blue-300/15", dot: "bg-blue-600 dark:bg-blue-300", tone: "blue" },
  new: { label: "New", ring: "stroke-violet-600 dark:stroke-violet-300", fill: "fill-violet-500/15 dark:fill-violet-300/15", dot: "bg-violet-600 dark:bg-violet-300", tone: "violet" },
  quiet: { label: "Quiet", ring: "stroke-zinc-400 dark:stroke-zinc-500", fill: "fill-zinc-400/10 dark:fill-zinc-400/10", dot: "bg-zinc-400", tone: "zinc" },
};
const SUB_FILL: Record<Story["status"], string> = {
  growing: "fill-blue-600/30 dark:fill-blue-300/30", new: "fill-violet-600/30 dark:fill-violet-300/30", quiet: "fill-zinc-500/25 dark:fill-zinc-400/25",
};

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const watch = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    watch.observe(ref.current);
    return () => watch.disconnect();
  }, []);
  return [ref, size];
}

/** What a point adds to its story's size. */
function weight(p: Point, by: "engagement" | "alerts"): number {
  return by === "engagement" ? Math.max(p.e, 1) : 1;
}

function lines(text: string, perLine: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (const word of words) {
    const last = out[out.length - 1];
    if (last !== undefined && (last + " " + word).length <= perLine) out[out.length - 1] = `${last} ${word}`;
    else if (out.length < 2) out.push(word.length > perLine ? `${word.slice(0, Math.max(1, perLine - 1))}…` : word);
    else {
      out[1] = `${out[1].slice(0, Math.max(1, perLine - 1))}…`;
      break;
    }
  }
  return out;
}

function StoryMap({ stories, by, at, selected, onSelect }: { stories: Story[]; by: "engagement" | "alerts"; at: number; selected: string | null; onSelect: (id: string) => void }) {
  const [box, size] = useSize<HTMLDivElement>();
  const aspect = size.w && size.h ? Math.min(2.4, Math.max(0.6, size.w / size.h)) : 1.6;
  const layout = useMemo(() => {
    const total = stories.map((s) => s.points.reduce((sum, p) => sum + weight(p, by), 0));
    const most = Math.max(...total, 1);
    const circles = pack(total.map((t) => Math.max(9, 92 * Math.sqrt(t / most))), aspect, 3);
    const subs = stories.map((s, i) => {
      if (s.sub.length < 2) return [] as Circle[];
      const each = s.sub.map((_, k) => s.points.filter((p) => p.s === k).reduce((sum, p) => sum + weight(p, by), 0));
      return packInside(each.map((v) => Math.sqrt(Math.max(v, 0.0001))), circles[i].r * 0.84);
    });
    return { circles, subs, total, view: bounds(circles, 10) };
  }, [stories, by, aspect]);
  const { view } = layout;
  const scale = size.w && size.h ? Math.min(size.w / view.w, size.h / view.h) : 1;

  return (
    <div ref={box} className="h-[58vh] min-h-[340px] w-full">
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} className="size-full" role="group" aria-label="Story map: one circle per story, sized by how large it is">
        <defs>
          <linearGradient id="story-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4285f4" /><stop offset=".5" stopColor="#9b72cb" /><stop offset="1" stopColor="#d96570" />
          </linearGradient>
        </defs>
        {stories.map((s, i) => {
          const c = layout.circles[i];
          const seen = s.points.filter((p) => Date.parse(p.t) <= at);
          const now = seen.reduce((sum, p) => sum + weight(p, by), 0);
          if (!now) return null;
          const r = c.r * Math.sqrt(now / layout.total[i]);
          const px = r * scale;
          const look = STATUS[s.status];
          const active = selected === s.story_id;
          const label = px >= 34 ? lines(s.title, Math.max(4, Math.floor((px * 1.7) / 6.6))) : [];
          const font = 12 / scale;
          return (
            <g key={s.story_id} role="button" tabIndex={0} aria-pressed={active}
              aria-label={`${s.title}: ${seen.length} alerts, ${look.label.toLowerCase()}${s.needs ? `, ${s.needs} need action` : ""}`}
              onClick={() => onSelect(s.story_id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.story_id); } }}
              className="cursor-pointer outline-none [&:focus-visible>circle:first-of-type]:stroke-[3px]">
              <title>{`${s.title}\n${seen.length} of ${s.alerts} alerts · ${fmtNum(seen.reduce((sum, p) => sum + p.e, 0))} engagement`}</title>
              <circle cx={c.x} cy={c.y} r={r} vectorEffect="non-scaling-stroke"
                className={cx("transition-[r] duration-300 ease-out motion-reduce:transition-none", look.fill, s.needs ? "" : look.ring, active ? "stroke-[3px]" : "stroke-[1.5px]")}
                stroke={s.needs ? "url(#story-ring)" : undefined} strokeWidth={s.needs ? (active ? 4 : 2.5) : undefined} />
              {px >= 26 && layout.subs[i].map((sc, k) => {
                const part = seen.filter((p) => p.s === k).reduce((sum, p) => sum + weight(p, by), 0);
                const whole = s.points.filter((p) => p.s === k).reduce((sum, p) => sum + weight(p, by), 0);
                if (!part) return null;
                const grow = Math.sqrt(now / layout.total[i]);
                return <circle key={k} cx={c.x + sc.x * grow} cy={c.y + sc.y * grow} r={sc.r * grow * Math.sqrt(part / whole)} className={cx("transition-[r] duration-300 ease-out motion-reduce:transition-none", SUB_FILL[s.status])} />;
              })}
              {label.map((text, n) => (
                <text key={n} x={c.x} y={c.y + (n - (label.length - 1) / 2) * font * 1.25 - (px >= 52 ? font * 0.6 : 0)} textAnchor="middle" dominantBaseline="middle"
                  fontSize={font} className="pointer-events-none fill-zinc-900 font-medium dark:fill-zinc-50">{text}</text>
              ))}
              {px >= 52 && (
                <text x={c.x} y={c.y + (label.length / 2) * font * 1.25 + font * 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={font * 0.9}
                  className="pointer-events-none fill-zinc-600 dark:fill-zinc-300">{seen.length} {seen.length === 1 ? "alert" : "alerts"}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function GrowthLine({ story, by }: { story: Story; by: "engagement" | "alerts" }) {
  const values = story.growth.map((g) => (by === "engagement" ? g.engagement : g.alerts));
  const top = Math.max(...values, 1);
  const w = 300;
  const h = 64;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(h - 4 - (v / top) * (h - 8)).toFixed(1)}`).join(" ");
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" role="img"
        aria-label={`Running total of ${by === "engagement" ? "engagement" : "alerts"} by the hour, from ${fmtNum(values[0] ?? 0)} to ${fmtNum(values[values.length - 1] ?? 0)}`}>
        <path d={`${path} L${w},${h} L0,${h} Z`} className="fill-blue-500/15 dark:fill-blue-300/15" />
        <path d={path} fill="none" vectorEffect="non-scaling-stroke" className="stroke-blue-600 stroke-2 dark:stroke-blue-300" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{fmtDateTime(story.growth[0]?.t)}</span><span>{by === "engagement" ? "Engagement" : "Alerts"}, running total</span><span>{fmtDateTime(story.growth[story.growth.length - 1]?.t)}</span>
      </figcaption>
    </figure>
  );
}

const HOW: Record<StoryAlert["how"], string> = { lead: "Started the story", meaning: "Same story by meaning", words: "Same story by words" };

function StoryPanel({ id, by, onClose }: { id: string; by: "engagement" | "alerts"; onClose: () => void }) {
  const detail = useApi<StoryDetail>(`/stories/${id}`, undefined, 30_000);
  const [sub, setSub] = useState<string | null>(null);
  useEffect(() => setSub(null), [id]);
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Card><Spinner /></Card>;
  const { story, alerts, chat } = detail.data;
  const look = STATUS[story.status];
  const shown = sub ? alerts.filter((a) => (a.issue_name ?? "") === sub) : alerts;
  return (
    <Card>
      <header className="mb-5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-zinc-950 dark:text-zinc-50">{story.title}</h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5"><Badge tone={look.tone}>{look.label}</Badge>{story.product && <Badge>{story.product}</Badge>}{story.tag && <Badge>{story.tag}</Badge>}</p>
        </div>
        <Button size="sm" className="shrink-0" onClick={onClose}>Close</Button>
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4 xl:grid-cols-2">
        {[["Alerts", fmtNum(story.alerts)], ["Engagement", fmtNum(story.engagement)], ["First alert", fmtDateTime(story.first_at)], ["Latest alert", fmtRelative(story.last_at)],
          ["Platforms", story.platforms.join(", ") || "none named"], ["Grouped by", story.by_meaning ? "meaning" : "words"]].map(([k, v]) => (
          <div key={k}><dt className="text-xs text-zinc-500 dark:text-zinc-400">{k}</dt><dd className="mt-0.5 text-zinc-900 dark:text-zinc-100">{v}</dd></div>
        ))}
      </dl>
      <div className="mt-5"><GrowthLine story={story} by={by} /></div>

      {story.sub.length > 1 && (
        <section className="mt-6">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Smaller stories in it</h3>
          <ul className="mt-2 flex flex-col gap-1">
            {story.sub.map((s) => (
              <li key={s.key}>
                <button type="button" onClick={() => setSub(sub === s.name ? null : s.name)} aria-pressed={sub === s.name}
                  className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors", sub === s.name ? "bg-blue-100 text-blue-900 dark:bg-blue-200/15 dark:text-blue-100" : "hover:bg-zinc-100 dark:hover:bg-zinc-800")}>
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{s.alerts} {s.alerts === 1 ? "alert" : "alerts"} · {fmtCompact(s.engagement)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{sub ? `Alerts in "${sub}"` : "Alerts"} <span className="font-normal text-zinc-500">({shown.length}{detail.data.total > detail.data.shown ? ` of ${detail.data.total}` : ""})</span></h3>
        <ul className="mt-2 flex flex-col gap-2">
          {shown.map((a) => (
            <li key={a.case_id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={a.status} />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{fmtDateTime(a.at)}{a.platform ? ` · ${a.platform}` : ""}{a.engagement_total !== null ? ` · ${fmtNum(a.engagement_total)} engagement` : ""}</span>
              </div>
              <p className="mt-1.5 text-sm text-zinc-900 dark:text-zinc-100">{a.alert_name ?? a.case_id}</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{HOW[a.how]}{a.sim !== null && a.how !== "lead" ? ` (${a.sim.toFixed(2)})` : ""}{a.also.length ? ` · also alerted as ${a.also.join(", ")}` : ""}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <Link to={`/feed/${a.case_id}`} className="text-blue-700 hover:underline dark:text-blue-300">Open alert {a.case_id}</Link>
                {a.post_url && /^https?:\/\//.test(a.post_url) && (
                  <a href={a.post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300">Open post<ExternalLink className="size-3.5" /></a>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Chat messages <span className="font-normal text-zinc-500">({chat.length})</span></h3>
        {!chat.length ? <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No Chat message is linked to these alerts.</p> : (
          <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {chat.map((m) => (
              <li key={m.activity_id} className="py-2.5">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{m.direction === "inbound" ? "Received from" : "Sent by"} {m.actor_name || m.actor} · {fmtDateTime(m.ts)}{m.case_id ? ` · ${m.case_id}` : ""}</p>
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-zinc-800 dark:text-zinc-200">{m.text}</p>
                {m.link && /^https?:\/\//.test(m.link) && <a href={m.link} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-blue-700 hover:underline dark:text-blue-300">Open in Chat<ExternalLink className="size-3.5" /></a>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}

export default function StoriesPage() {
  const { storyId } = useParams();
  const navigate = useNavigate();
  const [hours, setHours] = useState<number | null>(null);
  const [view, setView] = useState<"map" | "list">("map");
  const [frac, setFrac] = useState(1);
  const [playing, setPlaying] = useState(false);
  const data = useApi<StoriesResponse>("/stories", hours ? { hours } : undefined, 30_000);
  const stories = data.data?.stories ?? [];
  const by = data.data?.size_by ?? "engagement";
  const from = data.data ? Date.parse(data.data.since) : 0;
  const to = data.data ? Date.parse(data.data.as_of) : 0;
  const at = from + (to - from) * frac;

  useEffect(() => {
    if (!playing) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setInterval(() => setFrac((f) => {
      const next = Math.min(1, f + (calm ? 1 / 12 : 1 / 240));
      if (next >= 1) setPlaying(false);
      return next;
    }), calm ? 500 : 50);
    return () => window.clearInterval(id);
  }, [playing]);

  const select = (id: string) => navigate(storyId === id ? "/stories" : `/stories/${id}`);
  const span = hours ?? data.data?.hours ?? 72;
  const windows = [24, 72, 168, 336, 720].includes(span) ? [24, 72, 168, 336, 720] : [...new Set([24, 72, 168, 336, 720, span])].sort((a, b) => a - b);
  const totals = data.data?.totals;

  return (
    <div>
      <PageHeader title="Stories"
        description={totals ? `${totals.stories} stories from ${fmtNum(totals.alerts)} alerts · ${totals.growing} active · ${totals.needs} alerts need action` : undefined}
        actions={<>
          <Segmented label="View" value={view} onChange={setView} options={[{ value: "map", label: "Map" }, { value: "list", label: "List" }]} />
          <Segmented label="Window" value={span} onChange={(h) => { setHours(h); setFrac(1); }}
            options={windows.map((h) => ({ value: h, label: h < 48 ? `${h} h` : `${Math.round(h / 24)} days` }))} />
        </>} />
      <ErrorState error={data.error} onRetry={data.reload} />
      {data.loading && !data.data ? <Spinner /> : !stories.length ? (
        <Card><EmptyState icon={<Waypoints className="size-8" />} title="No stories in this window">Alerts are grouped into stories as they come in. Pick a longer window to look further back.</EmptyState></Card>
      ) : (
        <div className={cx("grid gap-5", storyId && "xl:grid-cols-[minmax(0,1fr)_430px]")}>
          <div className="min-w-0">
            {view === "map" ? (
              <Card padded={false} bodyClassName="p-3 sm:p-4">
                <StoryMap stories={stories.slice(0, ON_MAP)} by={by} at={at} selected={storyId ?? null} onSelect={select} />
                <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-zinc-100 px-1 pt-3 dark:border-zinc-800">
                  <Button variant="primary" icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                    onClick={() => { if (frac >= 1) setFrac(0); setPlaying((p) => !p); }}>{playing ? "Pause" : "Play growth"}</Button>
                  <input type="range" min={0} max={1000} value={Math.round(frac * 1000)} onChange={(e) => { setPlaying(false); setFrac(Number(e.target.value) / 1000); }}
                    aria-label="Time" aria-valuetext={fmtDateTime(new Date(at).toISOString())} className="h-1.5 min-w-40 flex-1 cursor-pointer accent-blue-600 dark:accent-blue-300" />
                  <span className="w-40 text-right text-sm tabular-nums text-zinc-600 dark:text-zinc-300">{frac >= 1 ? "Now" : fmtDateTime(new Date(at).toISOString())}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {(Object.keys(STATUS) as Story["status"][]).map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className={cx("size-2.5 rounded-full", STATUS[k].dot)} />{STATUS[k].label}</span>)}
                  <span className="inline-flex items-center gap-1.5"><span className="bg-spark size-2.5 rounded-full" />An alert needs action</span>
                  <span>Size: {by === "engagement" ? "engagement" : "number of alerts"}. Inner circles: the smaller stories in it.</span>
                  {stories.length > ON_MAP && <span>The {ON_MAP} largest of {stories.length} are drawn; the list has all of them.</span>}
                </div>
              </Card>
            ) : (
              <Card padded={false}>
                <table className="w-full min-w-[720px] border-collapse">
                  <thead><tr><th className={TH}>Story</th><th className={TH}>Status</th><th className={cx(TH, "text-right")}>Alerts</th><th className={cx(TH, "text-right")}>Engagement</th><th className={TH}>Smaller stories</th><th className={TH}>Latest alert</th></tr></thead>
                  <tbody>
                    {stories.map((s) => (
                      <tr key={s.story_id} className={cx(TR, storyId === s.story_id && "bg-blue-50 dark:bg-blue-200/10")}>
                        <td className={TD}>
                          <button type="button" onClick={() => select(s.story_id)} className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300">{s.title}</button>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">{[s.product, s.tag].filter(Boolean).join(" · ")}</p>
                        </td>
                        <td className={TD}><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>{s.needs > 0 && <span className="ml-2 text-xs text-rose-600 dark:text-rose-300">{s.needs} need action</span>}</td>
                        <td className={cx(TD, "text-right tabular-nums")}>{fmtNum(s.alerts)}</td>
                        <td className={cx(TD, "text-right tabular-nums")}>{fmtNum(s.engagement)}</td>
                        <td className={cx(TD, "tabular-nums")}>{s.sub.length}</td>
                        <td className={TD}>{fmtRelative(s.last_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </div>
          {storyId && <div className="min-w-0"><StoryPanel id={storyId} by={by} onClose={() => navigate("/stories")} /></div>}
        </div>
      )}
    </div>
  );
}
