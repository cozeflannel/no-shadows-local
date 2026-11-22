import { ExternalLink, Pause, Play, Search, Sparkles, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { apiSend, type ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { Badge, Button, Card, cx, EmptyState, ErrorState, Input, PageHeader, Segmented, Select, Spinner, StatusBadge, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative } from "../lib/format";
import { bounds, pack, packInside, type Circle } from "../lib/pack";

type Tone = "negative" | "neutral" | "positive" | "";  // "" = not rated: Gemini has not labelled it
type ViewBy = "story" | "product" | "topic" | "sentiment";
interface Sub { key: string; name: string; alerts: number; engagement: number; first_at: string; last_at: string }
interface Point { t: string; e: number; s: number; id: string; m: Tone }
interface Counts { negative: number; neutral: number; positive: number; unrated: number }
interface Story {
  story_id: string; title: string; tag: string; product: string; first_at: string; last_at: string; alerts: number; engagement: number; size: number;
  status: "new" | "growing" | "quiet"; needs: number; platforms: string[]; by_meaning: boolean; sub: Sub[]; points: Point[];
  growth: { t: string; alerts: number; engagement: number }[];
  topic: string; name: string; tone: Tone; sentiment: Counts; read_at: string | null; stale: boolean;
}
interface Facet { value: string; stories: number; alerts: number }
interface StoriesResponse {
  stories: Story[]; hours: number; since: string; as_of: string; size_by: "engagement" | "alerts"; active_hours: number; by_meaning: boolean;
  totals: { stories: number; alerts: number; engagement: number; growing: number; needs: number };
  reads_on: boolean; negative_share: number; positive_share: number; min_rated_share: number; facets: { products: Facet[]; topics: Facet[]; tones: Facet[] };
}
interface StoryAlert {
  case_id: string; alert_name: string | null; status: string; platform: string | null; engagement_total: number | null; post_url: string | null;
  author: string | null; issue_name: string | null; needs: string; at: string; how: "lead" | "meaning" | "words"; sim: number | null; also: string[];
  sentiment: Tone; post_text: string;
}
interface ChatRow { activity_id: string; ts: string; direction: string; actor: string; actor_name: string | null; text: string; link: string | null; case_id: string | null }
interface ReadView { topic: string; name: string; summary: string; at: string; read: number; members: number; model: string; stale: boolean }
interface StoryDetail { story: Story; read: ReadView | null; alerts: StoryAlert[]; chat: ChatRow[]; shown: number; total: number; reads_on: boolean }
/** One circle on the map: a story, or every story of one product, topic or sentiment. */
interface Part { key: string; fill: string; pts: Point[] }
interface Bubble { id: string; title: string; pts: Point[]; parts: Part[]; ring: string; fill: string; dashed: boolean; needs: number; caption: (alerts: number) => string; says: string }
interface Group { key: string; label: string; stories: Story[]; counts: Counts; tone: Tone; alerts: number; engagement: number; needs: number }

const ON_MAP = 120;
const STATUS: Record<Story["status"], { label: string; ring: string; fill: string; dot: string; tone: "blue" | "violet" | "zinc" }> = {
  growing: { label: "Growing", ring: "stroke-blue-600 dark:stroke-blue-300", fill: "fill-blue-500/15 dark:fill-blue-300/15", dot: "bg-blue-600 dark:bg-blue-300", tone: "blue" },
  new: { label: "New", ring: "stroke-violet-600 dark:stroke-violet-300", fill: "fill-violet-500/15 dark:fill-violet-300/15", dot: "bg-violet-600 dark:bg-violet-300", tone: "violet" },
  quiet: { label: "Quiet", ring: "stroke-zinc-400 dark:stroke-zinc-500", fill: "fill-zinc-400/10 dark:fill-zinc-400/10", dot: "bg-zinc-400", tone: "zinc" },
};
const SUB_FILL: Record<Story["status"], string> = {
  growing: "fill-blue-600/30 dark:fill-blue-300/30", new: "fill-violet-600/30 dark:fill-violet-300/30", quiet: "fill-zinc-500/25 dark:fill-zinc-400/25",
};
const NONE = "~none";  // a filter's value for "has none": no topic yet, not rated
const TONE: Record<"negative" | "neutral" | "positive" | "none", { label: string; ring: string; fill: string; sub: string; dot: string; bar: string; tone: "rose" | "zinc" | "emerald" }> = {
  negative: { label: "Negative", ring: "stroke-rose-600 dark:stroke-rose-400", fill: "fill-rose-500/20 dark:fill-rose-400/20", sub: "fill-rose-600/45 dark:fill-rose-400/45", dot: "bg-rose-600 dark:bg-rose-400", bar: "bg-rose-600 dark:bg-rose-400", tone: "rose" },
  neutral: { label: "Neutral", ring: "stroke-slate-500 dark:stroke-slate-400", fill: "fill-slate-400/15 dark:fill-slate-400/15", sub: "fill-slate-500/40 dark:fill-slate-400/40", dot: "bg-slate-500 dark:bg-slate-400", bar: "bg-slate-500 dark:bg-slate-400", tone: "zinc" },
  positive: { label: "Positive", ring: "stroke-emerald-600 dark:stroke-emerald-400", fill: "fill-emerald-500/15 dark:fill-emerald-400/15", sub: "fill-emerald-600/40 dark:fill-emerald-400/40", dot: "bg-emerald-600 dark:bg-emerald-400", bar: "bg-emerald-600 dark:bg-emerald-400", tone: "emerald" },
  none: { label: "Not rated", ring: "stroke-zinc-400 dark:stroke-zinc-500", fill: "fill-zinc-400/10 dark:fill-zinc-400/10", sub: "fill-zinc-400/25 dark:fill-zinc-500/30", dot: "bg-zinc-300 dark:bg-zinc-600", bar: "bg-zinc-300 dark:bg-zinc-600", tone: "zinc" },
};
const look = (t: Tone) => TONE[t || "none"];
const plural = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;

interface Bars { negative: number; positive: number; rated: number }

/** A group's tone from its counted labels, by the same rule the server uses for a story (the three bars are settings). */
function toneOf(c: Counts, bars: Bars): Tone {
  const rated = c.negative + c.neutral + c.positive;
  if (!rated || rated / (rated + c.unrated) < bars.rated) return "";
  if (c.negative / rated >= bars.negative) return "negative";
  if (c.positive / rated >= bars.positive) return "positive";
  return "neutral";
}

function countsText(c: Counts): string {
  return [`${fmtNum(c.negative)} negative`, `${fmtNum(c.neutral)} neutral`, `${fmtNum(c.positive)} positive`, c.unrated ? `${fmtNum(c.unrated)} not rated` : ""].filter(Boolean).join(" · ");
}

/** The stories put together by product, topic or sentiment, the biggest group first. */
function groupsOf(stories: Story[], by: Exclude<ViewBy, "story">, bars: Bars): Group[] {
  const found = new Map<string, Group>();
  for (const s of stories) {
    const key = by === "product" ? s.product : by === "topic" ? s.topic : s.tone;
    const label = by === "product" ? s.product || "No product named" : by === "topic" ? s.topic || "No topic yet" : look(s.tone).label;
    const g = found.get(key) ?? { key, label, stories: [], counts: { negative: 0, neutral: 0, positive: 0, unrated: 0 }, tone: "" as Tone, alerts: 0, engagement: 0, needs: 0 };
    g.stories.push(s);
    (Object.keys(g.counts) as (keyof Counts)[]).forEach((k) => { g.counts[k] += s.sentiment[k]; });
    g.alerts += s.alerts;
    g.engagement += s.engagement;
    g.needs += s.needs;
    found.set(key, g);
  }
  const out = [...found.values()];
  out.forEach((g) => { g.tone = by === "sentiment" ? (g.key as Tone) : toneOf(g.counts, bars); });
  return out.sort((a, b) => b.engagement - a.engagement || b.alerts - a.alerts);
}

function storyBubble(s: Story, color: "sentiment" | "activity"): Bubble {
  const status = STATUS[s.status];
  const tone = look(s.tone);
  const bySentiment = color === "sentiment";
  return {
    id: s.story_id, title: s.name || s.title, pts: s.points, needs: s.needs, dashed: bySentiment && !s.tone,
    ring: bySentiment ? tone.ring : status.ring, fill: bySentiment ? tone.fill : status.fill,
    parts: s.sub.length < 2 ? [] : s.sub.map((sub, k) => ({ key: sub.key, fill: bySentiment ? tone.sub : SUB_FILL[s.status], pts: s.points.filter((p) => p.s === k) })),
    caption: (n) => plural(n, "alert", "alerts"),
    says: `${bySentiment ? tone.label.toLowerCase() : status.label.toLowerCase()}${s.needs ? `, ${s.needs} need action` : ""}`,
  };
}

function groupBubble(g: Group, by: Exclude<ViewBy, "story">): Bubble {
  const tone = look(g.tone);
  const pts = g.stories.flatMap((s) => s.points);
  const parts: Part[] = by === "sentiment"
    ? g.stories.map((s) => ({ key: s.story_id, fill: tone.sub, pts: s.points }))
    : (["negative", "neutral", "positive", ""] as Tone[]).map((m) => ({ key: m || "none", fill: look(m).sub, pts: pts.filter((p) => p.m === m) })).filter((part) => part.pts.length);
  return {
    id: g.key, title: g.label, pts, needs: g.needs, dashed: !g.tone, ring: tone.ring, fill: tone.fill, parts: parts.length < 2 ? [] : parts,
    caption: (n) => `${plural(g.stories.length, "story", "stories")} · ${plural(n, "alert", "alerts")}`,
    says: `${tone.label.toLowerCase()}, ${countsText(g.counts)}${g.needs ? `, ${g.needs} need action` : ""}`,
  };
}

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

function BubbleMap({ bubbles, by, at, selected, onSelect, label }: { bubbles: Bubble[]; by: "engagement" | "alerts"; at: number; selected: string | null; onSelect: (id: string) => void; label: string }) {
  const [box, size] = useSize<HTMLDivElement>();
  const aspect = size.w && size.h ? Math.min(2.4, Math.max(0.6, size.w / size.h)) : 1.6;
  const layout = useMemo(() => {
    const sum = (pts: Point[]) => pts.reduce((total, p) => total + weight(p, by), 0);
    const total = bubbles.map((b) => sum(b.pts));
    const most = Math.max(...total, 1);
    const circles = pack(total.map((t) => Math.max(9, 92 * Math.sqrt(t / most))), aspect, 3);
    const parts = bubbles.map((b, i) => (b.parts.length < 2 ? [] as Circle[] : packInside(b.parts.map((part) => Math.sqrt(Math.max(sum(part.pts), 0.0001))), circles[i].r * 0.84)));
    return { circles, parts, total, view: bounds(circles, 10) };
  }, [bubbles, by, aspect]);
  const { view } = layout;
  const scale = size.w && size.h ? Math.min(size.w / view.w, size.h / view.h) : 1;
  const sumAt = (pts: Point[]) => pts.reduce((total, p) => (Date.parse(p.t) <= at ? total + weight(p, by) : total), 0);

  return (
    <div ref={box} className="h-[58vh] min-h-[340px] w-full">
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} className="size-full" role="group" aria-label={label}>
        <defs>
          <linearGradient id="story-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4285f4" /><stop offset=".5" stopColor="#9b72cb" /><stop offset="1" stopColor="#d96570" />
          </linearGradient>
        </defs>
        {bubbles.map((b, i) => {
          const c = layout.circles[i];
          const seen = b.pts.filter((p) => Date.parse(p.t) <= at);
          const now = sumAt(b.pts);
          if (!now) return null;
          const grow = Math.sqrt(now / layout.total[i]);
          const r = c.r * grow;
          const px = r * scale;
          const active = selected === b.id;
          const text = px >= 34 ? lines(b.title, Math.max(4, Math.floor((px * 1.7) / 6.6))) : [];
          const font = 12 / scale;
          return (
            <g key={b.id} role="button" tabIndex={0} aria-pressed={active} aria-label={`${b.title}: ${b.caption(seen.length)}, ${b.says}`}
              onClick={() => onSelect(b.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(b.id); } }}
              className="cursor-pointer outline-none [&:focus-visible>circle:first-of-type]:stroke-[3px]">
              <title>{`${b.title}\n${b.caption(seen.length)} · ${fmtNum(seen.reduce((sum, p) => sum + p.e, 0))} engagement\n${b.says}`}</title>
              <circle cx={c.x} cy={c.y} r={r} vectorEffect="non-scaling-stroke" strokeDasharray={b.dashed && !b.needs ? "4 3" : undefined}
                className={cx("transition-[r] duration-300 ease-out motion-reduce:transition-none", b.fill, b.needs ? "" : b.ring, active ? "stroke-[3px]" : "stroke-[1.5px]")}
                stroke={b.needs ? "url(#story-ring)" : undefined} strokeWidth={b.needs ? (active ? 4 : 2.5) : undefined} />
              {px >= 26 && layout.parts[i].map((pc, k) => {
                const part = sumAt(b.parts[k].pts);
                const whole = b.parts[k].pts.reduce((total, p) => total + weight(p, by), 0);
                if (!part) return null;
                return <circle key={b.parts[k].key} cx={c.x + pc.x * grow} cy={c.y + pc.y * grow} r={pc.r * grow * Math.sqrt(part / whole)} className={cx("transition-[r] duration-300 ease-out motion-reduce:transition-none", b.parts[k].fill)} />;
              })}
              {text.map((line, n) => (
                <text key={n} x={c.x} y={c.y + (n - (text.length - 1) / 2) * font * 1.25 - (px >= 52 ? font * 0.6 : 0)} textAnchor="middle" dominantBaseline="middle"
                  fontSize={font} className="pointer-events-none fill-zinc-900 font-medium dark:fill-zinc-50">{line}</text>
              ))}
              {px >= 52 && (
                <text x={c.x} y={c.y + (text.length / 2) * font * 1.25 + font * 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={font * 0.9}
                  className="pointer-events-none fill-zinc-600 dark:fill-zinc-300">{b.caption(seen.length)}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** The counted labels as one bar, with the numbers in words under it. */
function SentimentBar({ counts }: { counts: Counts }) {
  const total = counts.negative + counts.neutral + counts.positive + counts.unrated;
  if (!total) return null;
  const parts: [keyof typeof TONE, number][] = [["negative", counts.negative], ["neutral", counts.neutral], ["positive", counts.positive], ["none", counts.unrated]];
  return (
    <figure>
      <div className="flex h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" role="img" aria-label={`Posts by sentiment: ${countsText(counts)}`}>
        {parts.filter(([, n]) => n > 0).map(([k, n]) => <span key={k} className={TONE[k].bar} style={{ width: `${(n / total) * 100}%` }} />)}
      </div>
      <figcaption className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{countsText(counts)}</figcaption>
    </figure>
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

function ToneBadge({ tone }: { tone: Tone }) {
  return <Badge tone={look(tone).tone}><span className={cx("mr-1.5 inline-block size-2 rounded-full", look(tone).dot)} />{look(tone).label}</Badge>;
}

function StoryPanel({ id, by, canAct, onClose, onRead }: { id: string; by: "engagement" | "alerts"; canAct: boolean; onClose: () => void; onRead: () => void }) {
  const { toast } = useApp();
  const detail = useApi<StoryDetail>(`/stories/${id}`, undefined, 30_000);
  const [sub, setSub] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => setSub(null), [id]);
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Card><Spinner /></Card>;
  const { story, alerts, chat, read, reads_on: readsOn } = detail.data;
  const status = STATUS[story.status];
  const shown = sub ? alerts.filter((a) => (a.issue_name ?? "") === sub) : alerts;
  const rated = story.sentiment.negative + story.sentiment.neutral + story.sentiment.positive;
  const readNow = async () => {
    setReading(true);
    try {
      await apiSend("post", `/stories/${id}/read`);
      detail.reload();
      onRead();
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setReading(false); }
  };
  return (
    <Card>
      <header className="mb-5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-zinc-950 dark:text-zinc-50">{read?.name || story.title}</h2>
          {read?.name && read.name !== story.title && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Burson's name: {story.title}</p>}
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ToneBadge tone={story.tone} /><Badge tone={status.tone}>{status.label}</Badge>
            {story.topic && <Badge tone="blue">{story.topic}</Badge>}{story.product && <Badge>{story.product}</Badge>}{story.tag && <Badge>{story.tag}</Badge>}
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={onClose}>Close</Button>
      </header>

      <section className="mb-5 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800" aria-label="Gemini's read of this story">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100"><Sparkles className="size-4 text-blue-600 dark:text-blue-300" aria-hidden />Gemini's read</h3>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{read ? `${fmtRelative(read.at)} · ${plural(read.read, "post", "posts")} read` : "not read yet"}</span>
          <Button size="sm" className="ml-auto" loading={reading} disabled={!canAct || !readsOn} onClick={readNow}
            title={readsOn ? undefined : 'Turn on "Gemini reads each story" under Settings, Switches'}>{read ? "Read again" : "Read now"}</Button>
        </div>
        {read ? <p className="mt-2.5 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{read.summary}</p>
          : <p className="mt-2.5 text-sm text-zinc-500 dark:text-zinc-400">{readsOn ? "Gemini reads the biggest unread stories first, a few on every run." : 'Gemini is not reading stories: the switch "Gemini reads each story" is OFF.'}</p>}
        {read?.stale && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{plural(Math.max(0, story.alerts - read.members), "alert has", "alerts have")} joined since this read. They are not rated yet.</p>}
        {(rated > 0 || !!read) && (
          <div className="mt-3">
            <SentimentBar counts={story.sentiment} />
            {rated > 0 && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{fmtNum(story.sentiment.negative)} of {plural(rated, "rated post is", "rated posts are")} negative. Counted from the label on each post.</p>}
          </div>
        )}
      </section>

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
            {story.sub.map((x) => (
              <li key={x.key}>
                <button type="button" onClick={() => setSub(sub === x.name ? null : x.name)} aria-pressed={sub === x.name}
                  className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors", sub === x.name ? "bg-blue-100 text-blue-900 dark:bg-blue-200/15 dark:text-blue-100" : "hover:bg-zinc-100 dark:hover:bg-zinc-800")}>
                  <span className="min-w-0 flex-1 truncate">{x.name}</span>
                  <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{x.alerts} {x.alerts === 1 ? "alert" : "alerts"} · {fmtCompact(x.engagement)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{sub ? `Posts in "${sub}"` : "Posts"} <span className="font-normal text-zinc-500">({shown.length}{detail.data.total > detail.data.shown ? ` of ${detail.data.total}` : ""})</span></h3>
        <ul className="mt-2 flex flex-col gap-2">
          {shown.map((a) => (
            <li key={a.case_id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <ToneBadge tone={a.sentiment} /><StatusBadge status={a.status} />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{fmtDateTime(a.at)}{a.platform ? ` · ${a.platform}` : ""}{a.engagement_total !== null ? ` · ${fmtNum(a.engagement_total)} engagement` : ""}</span>
              </div>
              <p className="mt-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">{a.issue_name || a.alert_name || a.case_id}</p>
              {a.post_text && <p className="mt-1 line-clamp-4 whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-300">{a.post_text}</p>}
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{a.author ? `${a.author} · ` : ""}{HOW[a.how]}{a.sim !== null && a.how !== "lead" ? ` (${a.sim.toFixed(2)})` : ""}{a.also.length ? ` · also alerted as ${a.also.join(", ")}` : ""}</p>
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

const GROUP_NOUN: Record<Exclude<ViewBy, "story">, string> = { product: "Product", topic: "Topic", sentiment: "Sentiment" };

/** Every story of one product, topic or sentiment: its counted labels and the stories in it, biggest first. */
function GroupPanel({ group, by, onOpen, onOnly, onClose }: { group: Group; by: Exclude<ViewBy, "story">; onOpen: (storyId: string) => void; onOnly: () => void; onClose: () => void }) {
  const rated = group.counts.negative + group.counts.neutral + group.counts.positive;
  return (
    <Card>
      <header className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{GROUP_NOUN[by]}</p>
          <h2 className="text-base font-medium text-zinc-950 dark:text-zinc-50">{group.label}</h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5"><ToneBadge tone={group.tone} />{group.needs > 0 && <Badge tone="rose">{group.needs} need action</Badge>}</p>
        </div>
        <Button size="sm" className="shrink-0" onClick={onClose}>Close</Button>
      </header>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
        {[["Stories", fmtNum(group.stories.length)], ["Alerts", fmtNum(group.alerts)], ["Engagement", fmtNum(group.engagement)]].map(([k, v]) => (
          <div key={k}><dt className="text-xs text-zinc-500 dark:text-zinc-400">{k}</dt><dd className="mt-0.5 text-zinc-900 dark:text-zinc-100">{v}</dd></div>
        ))}
      </dl>
      <div className="mt-4">
        <SentimentBar counts={group.counts} />
        {rated > 0 && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{fmtNum(group.counts.negative)} of {plural(rated, "rated post is", "rated posts are")} negative.</p>}
      </div>
      <Button size="sm" className="mt-4" onClick={onOnly}>Show only these stories</Button>
      <h3 className="mt-6 text-sm font-medium text-zinc-900 dark:text-zinc-100">Stories <span className="font-normal text-zinc-500">({group.stories.length})</span></h3>
      <ul className="mt-2 flex flex-col gap-2">
        {group.stories.map((x) => (
          <li key={x.story_id}>
            <button type="button" onClick={() => onOpen(x.story_id)} className="block w-full rounded-xl border border-zinc-200 p-3 text-left transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50">
              <span className="flex items-start gap-2">
                <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", look(x.tone).dot)} aria-hidden />
                <span className="min-w-0 flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">{x.name || x.title}</span>
              </span>
              <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                {look(x.tone).label} · {plural(x.alerts, "alert", "alerts")} · {fmtCompact(x.engagement)} engagement · {fmtRelative(x.last_at)}{by !== "topic" && x.topic ? ` · ${x.topic}` : ""}{by !== "product" && x.product ? ` · ${x.product}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function StoriesPage() {
  const { me } = useApp();
  const { storyId } = useParams();
  const navigate = useNavigate();
  const [hours, setHours] = useState<number | null>(null);
  const [view, setView] = useState<"map" | "list">("map");
  const [viewBy, setViewBy] = useState<ViewBy>("story");
  const [color, setColor] = useState<"sentiment" | "activity">("sentiment");
  const [product, setProduct] = useState("");
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("");
  const [find, setFind] = useState("");
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [frac, setFrac] = useState(1);
  const [playing, setPlaying] = useState(false);
  const data = useApi<StoriesResponse>("/stories", hours ? { hours } : undefined, 30_000);
  const all = data.data?.stories ?? [];
  const by = data.data?.size_by ?? "engagement";
  const from = data.data ? Date.parse(data.data.since) : 0;
  const to = data.data ? Date.parse(data.data.as_of) : 0;
  const at = from + (to - from) * frac;
  const negativeBar = data.data?.negative_share ?? 1;
  const positiveBar = data.data?.positive_share ?? 1;
  const ratedBar = data.data?.min_rated_share ?? 1;

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

  const stories = useMemo(() => {
    const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((s) => (!product || s.product === product)
      && (!topic || (topic === NONE ? !s.topic : s.topic === topic))
      && (!tone || (tone === NONE ? !s.tone : s.tone === tone))
      && (!words.length || words.every((w) => [s.title, s.name, s.topic, s.product, ...s.sub.map((x) => x.name)].join(" ").toLowerCase().includes(w))));
  }, [all, product, topic, tone, find]);
  const groups = useMemo(() => (viewBy === "story" ? [] : groupsOf(stories, viewBy, { negative: negativeBar, positive: positiveBar, rated: ratedBar })),
    [stories, viewBy, negativeBar, positiveBar, ratedBar]);
  const bubbles = useMemo(() => (viewBy === "story" ? stories.slice(0, ON_MAP).map((s) => storyBubble(s, color)) : groups.map((g) => groupBubble(g, viewBy))), [stories, groups, viewBy, color]);
  const group = viewBy === "story" ? null : groups.find((g) => g.key === groupKey) ?? null;

  const select = (id: string) => navigate(storyId === id ? "/stories" : `/stories/${id}`);
  const pickGroup = (key: string) => { setGroupKey(groupKey === key ? null : key); if (storyId) navigate("/stories"); };
  const changeViewBy = (next: ViewBy) => { setViewBy(next); setGroupKey(null); };
  const onlyGroup = (g: Group) => {
    if (viewBy === "product") setProduct(g.key);
    if (viewBy === "topic") setTopic(g.key || NONE);
    if (viewBy === "sentiment") setTone(g.key || NONE);
    changeViewBy("story");
  };
  const filtered = !!(product || topic || tone || find.trim());
  const clear = () => { setProduct(""); setTopic(""); setTone(""); setFind(""); };
  const span = hours ?? data.data?.hours ?? 72;
  const windows = [24, 72, 168, 336, 720].includes(span) ? [24, 72, 168, 336, 720] : [...new Set([24, 72, 168, 336, 720, span])].sort((a, b) => a - b);
  const totals = data.data?.totals;
  const facets = data.data?.facets;
  const unread = all.filter((s) => !s.read_at).length;
  const side = storyId || group;
  const mapLabel = viewBy === "story" ? "Story map: one circle per story, sized by how large it is"
    : `Story map: one circle per ${viewBy === "sentiment" ? "sentiment" : viewBy}, sized by how large its stories are`;

  return (
    <div>
      <PageHeader title="Stories"
        description={totals ? `${totals.stories} stories from ${fmtNum(totals.alerts)} alerts · ${totals.growing} active · ${totals.needs} alerts need action${filtered ? ` · showing ${stories.length}` : ""}` : undefined}
        actions={<>
          <Segmented label="View" value={view} onChange={setView} options={[{ value: "map", label: "Map" }, { value: "list", label: "List" }]} />
          <Segmented label="Window" value={span} onChange={(h) => { setHours(h); setFrac(1); }}
            options={windows.map((h) => ({ value: h, label: h < 48 ? `${h} h` : `${Math.round(h / 24)} days` }))} />
        </>} />
      <ErrorState error={data.error} onRetry={data.reload} />
      {data.loading && !data.data ? <Spinner /> : !all.length ? (
        <Card><EmptyState icon={<Waypoints className="size-8" />} title="No stories in this window">Alerts are grouped into stories as they come in. Pick a longer window to look further back.</EmptyState></Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
            <div>
              <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">View by</p>
              <Segmented label="View by" value={viewBy} onChange={changeViewBy}
                options={[{ value: "story", label: "Story" }, { value: "product", label: "Product" }, { value: "topic", label: "Topic" }, { value: "sentiment", label: "Sentiment" }]} />
            </div>
            {viewBy === "story" && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Color by</p>
                <Segmented label="Color by" value={color} onChange={setColor} options={[{ value: "sentiment", label: "Sentiment" }, { value: "activity", label: "Activity" }]} />
              </div>
            )}
            <label className="min-w-36 flex-1 sm:max-w-48">
              <span className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Product</span>
              <Select value={product} onChange={(e) => setProduct(e.target.value)}>
                <option value="">All products</option>
                {facets?.products.map((f) => <option key={f.value} value={f.value}>{f.value} ({f.stories})</option>)}
              </Select>
            </label>
            <label className="min-w-36 flex-1 sm:max-w-48">
              <span className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Topic</span>
              <Select value={topic} onChange={(e) => setTopic(e.target.value)}>
                <option value="">All topics</option>
                {facets?.topics.map((f) => <option key={f.value} value={f.value}>{f.value} ({f.stories})</option>)}
                <option value={NONE}>No topic yet</option>
              </Select>
            </label>
            <label className="min-w-36 flex-1 sm:max-w-44">
              <span className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Sentiment</span>
              <Select value={tone} onChange={(e) => setTone(e.target.value)}>
                <option value="">Any sentiment</option>
                <option value="negative">Negative</option><option value="neutral">Neutral</option><option value="positive">Positive</option>
                <option value={NONE}>Not rated</option>
              </Select>
            </label>
            <label className="min-w-44 flex-1 sm:max-w-60">
              <span className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Find a story</span>
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
                <Input className="pl-9" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Issue name or words" />
              </span>
            </label>
            {filtered && <Button onClick={clear}>Clear filters</Button>}
          </div>
          {!data.data?.reads_on && (
            <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">Topics and sentiment come from Gemini's read of each story. The switch "Gemini reads each story" is OFF, so stories show as not rated. <Link className="text-blue-700 underline dark:text-blue-300" to="/settings/flags">Switches</Link></p>
          )}
          {!stories.length ? (
            <Card><EmptyState icon={<Waypoints className="size-8" />} title="No story fits these filters">Change a filter above, or clear them.</EmptyState></Card>
          ) : (
            <div className={cx("grid gap-5", side && "xl:grid-cols-[minmax(0,1fr)_430px]")}>
              <div className="min-w-0">
                {view === "map" ? (
                  <Card padded={false} bodyClassName="p-3 sm:p-4">
                    <BubbleMap bubbles={bubbles} by={by} at={at} label={mapLabel}
                      selected={viewBy === "story" ? storyId ?? null : groupKey} onSelect={viewBy === "story" ? select : pickGroup} />
                    <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-zinc-100 px-1 pt-3 dark:border-zinc-800">
                      <Button variant="primary" icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                        onClick={() => { if (frac >= 1) setFrac(0); setPlaying((p) => !p); }}>{playing ? "Pause" : "Play growth"}</Button>
                      <input type="range" min={0} max={1000} value={Math.round(frac * 1000)} onChange={(e) => { setPlaying(false); setFrac(Number(e.target.value) / 1000); }}
                        aria-label="Time" aria-valuetext={fmtDateTime(new Date(at).toISOString())} className="h-1.5 min-w-40 flex-1 cursor-pointer accent-blue-600 dark:accent-blue-300" />
                      <span className="w-40 text-right text-sm tabular-nums text-zinc-600 dark:text-zinc-300">{frac >= 1 ? "Now" : fmtDateTime(new Date(at).toISOString())}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {viewBy === "story" && color === "activity"
                        ? (Object.keys(STATUS) as Story["status"][]).map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className={cx("size-2.5 rounded-full", STATUS[k].dot)} />{STATUS[k].label}</span>)
                        : (["negative", "neutral", "positive", "none"] as const).map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className={cx("size-2.5 rounded-full", TONE[k].dot)} />{TONE[k].label}</span>)}
                      <span className="inline-flex items-center gap-1.5"><span className="bg-spark size-2.5 rounded-full" />An alert needs action</span>
                      <span>
                        Size: {by === "engagement" ? "engagement" : "number of alerts"}.{" "}
                        {viewBy === "story" ? "Inner circles: the smaller stories in it." : viewBy === "sentiment" ? "Inner circles: the stories in it." : "Inner circles: its posts by sentiment."}
                        {!(viewBy === "story" && color === "activity") && ` Red: at least ${Math.round(negativeBar * 100)}% of the rated posts are negative.`}
                      </span>
                      {data.data?.reads_on && unread > 0 && <span>{plural(unread, "story is", "stories are")} not read yet.</span>}
                      {viewBy === "story" && stories.length > ON_MAP && <span>The {ON_MAP} largest of {stories.length} are drawn; the list has all of them.</span>}
                    </div>
                  </Card>
                ) : (
                  <Card padded={false}>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[860px] border-collapse">
                        <thead><tr><th className={TH}>Story</th><th className={TH}>Sentiment</th><th className={TH}>Topic</th><th className={TH}>Status</th><th className={cx(TH, "text-right")}>Alerts</th><th className={cx(TH, "text-right")}>Engagement</th><th className={TH}>Latest alert</th></tr></thead>
                        <tbody>
                          {stories.map((s) => (
                            <tr key={s.story_id} className={cx(TR, storyId === s.story_id && "bg-blue-50 dark:bg-blue-200/10")}>
                              <td className={TD}>
                                <button type="button" onClick={() => select(s.story_id)} className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300">{s.name || s.title}</button>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">{[s.product, s.tag, s.sub.length > 1 ? `${s.sub.length} smaller stories` : ""].filter(Boolean).join(" · ")}</p>
                              </td>
                              <td className={TD}><ToneBadge tone={s.tone} />{s.tone && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{countsText(s.sentiment)}</p>}</td>
                              <td className={TD}>{s.topic || <span className="text-zinc-400">none yet</span>}</td>
                              <td className={TD}><Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>{s.needs > 0 && <span className="ml-2 text-xs text-rose-600 dark:text-rose-300">{s.needs} need action</span>}</td>
                              <td className={cx(TD, "text-right tabular-nums")}>{fmtNum(s.alerts)}</td>
                              <td className={cx(TD, "text-right tabular-nums")}>{fmtNum(s.engagement)}</td>
                              <td className={TD}>{fmtRelative(s.last_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </div>
              {storyId ? <div className="min-w-0"><StoryPanel id={storyId} by={by} canAct={!!me?.can_act} onClose={() => navigate("/stories")} onRead={data.reload} /></div>
                : group && viewBy !== "story" ? <div className="min-w-0"><GroupPanel group={group} by={viewBy} onOpen={(id) => navigate(`/stories/${id}`)} onOnly={() => onlyGroup(group)} onClose={() => setGroupKey(null)} /></div> : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
