import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { useApi } from "../api/hooks";
import { fmtDateTime, fmtNum } from "../lib/format";
import { SafeHtml } from "./SafeHtml";
import { ConvertReport, type ConvertResult, type FormInfo } from "./TempCheckForm";
import { Alert, Badge, Button, KV, Modal, Tabs } from "./ui";

export interface TcPost {
  key: string; x?: boolean; id?: string; source: string; author: string; text: string; url: string; eng: number | null; negative: boolean;
  at: string | null; likes?: number; replies?: number; text_from?: string;
}
interface Ranked { label: string; n: number }
export interface TcCheck {
  check_id: string; issue: string; status: string; basis: string; standing: boolean; total: number; created_at: string; completed_at: string | null;
  window_from: string | null; window_to: string | null; title: string; writeup_text: string; writeup_html: string; notes: string[];
  start: { at?: string; why?: string }; hours: { at: string; n: number }[];
  velocity: { peak: { at: string; n: number }; last: { at: string; n: number }; pct: number } | null;
  sentiment: Record<string, number>; sources: Ranked[]; eng_sources: Ranked[]; mention_types: Ranked[];
  posts: TcPost[]; read_posts: TcPost[]; coverage: { ranked?: number; x?: number; from_embed?: number; in_rows?: number; no_words?: number };
  chart: { title?: string; unit?: string; points?: { label: string; n: number }[] }; update: { at: string; total: number } | null;
  gem: { summary?: string; why?: string }; level: { label?: string; why?: string; action?: string; side?: string; pct?: number; n?: number; known?: number; full_year?: boolean; hours?: number };
  query: { id?: number; name?: string; boolean?: string; origin?: string; pct?: number | null; drafted?: boolean; draft_why?: string; report?: ConvertResult["report"];
    widened?: { from: string; why: string }; relevance?: { about: number; read: number } };
  standing_detail: { queries?: number; skipped?: string };
  own: { boolean?: string; origin?: string; from?: string; to?: string; total?: number | null; hours?: { at: string; n: number }[]; sources?: Ranked[]; eng_sources?: Ranked[];
    error?: string; kept?: number; reused?: { kept: number; since: number; gathered_at: string; note: string } };
  tables: { key: string; label: string; matched?: number; scan_gb?: number; skipped?: string; error?: string; freshness?: string }[];
  own_total: number | null; keep_refreshed_until: string | null;
}

const BW = "#4285f4";       // Brandwatch is blue and our own tables are orange throughout
const BW_SOFT = "#c6dafc";
const BW_PEAK = "#174ea6";
const OURS = "#f29900";
const OURS_SOFT = "#fde3b0";
const OURS_PEAK = "#b06000";
const TONES = { negative: "#d93025", neutral: "#9aa0a6", positive: "#188038" };
const TYPES: Record<string, string> = { "original posts": BW, reposts: "#9aa0a6", comments: OURS };
const PLATFORM: Record<string, string> = { X: "#5f6368", Reddit: "#ff4500", Bluesky: "#1185fe", Instagram: "#c13584", Facebook: "#1877f2", YouTube: "#ff0000", TikTok: "#00b3a7", Threads: "#5f6368", LinkedIn: "#0a66c2" };
const OTHER = "#9aa0a6";
const PRE = "scroll-thin mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100 p-3 font-mono text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";
const WHY: Record<string, string> = { spike: "the first busy hour", alert: "when the alert fired", query: "when the query was made", since: "the time you chose" };
const pctOf = (n: number, total: number) => (total ? `${Math.round((n * 100) / total)}%` : "");
const ranked = (list: Ranked[] | undefined, total?: number) => (list ?? []).map((x) => `${x.label} ${fmtNum(Math.round(x.n))}${total ? ` (${pctOf(x.n, total)})` : ""}`).join(" · ") || "none";
const hourTick = (at: string) => new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric" });
const tip = { cursor: { fill: "rgb(128 134 139 / 0.12)" }, contentStyle: { borderRadius: 12, border: "none", background: "#1e1f20", color: "#e3e3e3", fontSize: 12 } };
const axis = { tick: { fontSize: 11, fill: "#80868b" }, axisLine: false, tickLine: false } as const;

/** The first `max` of a ranked list, the rest added up as "Other". */
function topWithOther(list: Ranked[] | undefined, max: number): Ranked[] {
  const rows = (list ?? []).filter((x) => x.n > 0);
  const rest = rows.slice(max).reduce((n, x) => n + x.n, 0);
  return rest > 0 ? [...rows.slice(0, max), { label: "Other", n: rest }] : rows.slice(0, max);
}

/**
 * The address of a platform's own embed frame for a post, built from the post's id alone; null for anything else.
 * (The temp check app's embedFor.)
 */
export function embedFor(url: string): { site: string; src: string; height?: number; ratio?: number } | null {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u) || u.length > 2000 || /[\s<>"'`]/.test(u)) return null;
  let m = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{1,30}\/status(?:es)?\/(\d{5,25})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: "X", src: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&dnt=true&theme=light`, height: 560 };
  m = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/)([A-Za-z0-9_-]{11})(?:[&/?#]|$)/i.exec(u) ?? /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: "YouTube", src: `https://www.youtube-nocookie.com/embed/${m[1]}`, ratio: 16 / 9 };
  m = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]{1,40}\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,24})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: "Instagram", src: `https://www.instagram.com/${/^reel/i.test(m[1]) ? "reel" : m[1].toLowerCase()}/${m[2]}/embed/`, height: 640 };
  m = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[A-Za-z0-9_.-]{1,40}\/video\/(\d{8,25})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: "TikTok", src: `https://www.tiktok.com/embed/v2/${m[1]}`, height: 740 };
  m = /^https?:\/\/bsky\.app\/profile\/(did:plc:[a-z0-9]{10,40})\/post\/([a-z0-9]{8,20})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: "Bluesky", src: `https://embed.bsky.app/embed/${m[1].toLowerCase()}/app.bsky.feed.post/${m[2]}`, height: 520 };
  m = /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,30})\/comments\/([a-z0-9]{4,12})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: "Reddit", src: `https://embed.reddit.com/r/${m[1]}/comments/${m[2]}/?embed=true&theme=light`, height: 560 };
  return null;
}

/** A post's engagement as a number to compare and as words: X's likes and replies when X gave them, else its engagements. */
function engagementOf(p: TcPost): { n: number | null; text: string } {
  const f = (v: number, one: string, many: string) => `${fmtNum(Math.round(v))} ${Math.round(v) === 1 ? one : many}`;
  if (p.likes !== undefined && p.likes !== null) return { n: p.likes + (p.replies ?? 0), text: `${f(p.likes, "like", "likes")} · ${f(p.replies ?? 0, "reply", "replies")}` };
  if (p.eng === null || p.eng === undefined) return { n: null, text: "engagement not known" };
  return { n: p.eng, text: f(p.eng, "engagement", "engagements") };
}

/** Posts as cards. Opening one shows what we hold of it beside the post in its platform's own frame. */
function PostGrid({ posts }: { posts: TcPost[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!posts.length) return <p className="text-sm text-zinc-500">None.</p>;
  const most = Math.max(1, ...posts.map((p) => engagementOf(p).n ?? 0));
  const shown = open === null ? null : posts[open];
  const frame = shown ? embedFor(shown.url) : null;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {posts.map((p, i) => {
          const e = engagementOf(p);
          return (
            <button key={`${p.key}-${i}`} type="button" onClick={() => setOpen(i)} aria-label={`Open the post by ${p.author || "an unknown author"} on ${p.source || "the web"}`}
              className="flex flex-col gap-2 rounded-2xl border border-zinc-200 p-3 text-left transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-zinc-800 dark:hover:bg-zinc-800/40">
              <span className="flex items-center gap-2 text-xs">
                <span className="rounded-full px-2 py-0.5 font-medium text-white" style={{ background: PLATFORM[p.source] ?? OTHER }}>{p.source || "Web"}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 dark:text-zinc-200">{p.author || "unknown"}</span>
                {p.at && <span className="shrink-0 text-zinc-500">{fmtDateTime(p.at)}</span>}
              </span>
              <span className="line-clamp-4 text-sm text-zinc-700 dark:text-zinc-300">{p.text || "No words came with this post."}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden><span className="block h-full rounded-full bg-blue-500" style={{ width: `${e.n ? Math.max(2, Math.round((e.n * 100) / most)) : 0}%` }} /></span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                <span>{e.text}</span>{p.negative && <Badge tone="rose">negative</Badge>}{p.text_from && <Badge>words: {p.text_from}</Badge>}
                <span className="ml-auto text-blue-600 dark:text-blue-300">Open</span>
              </span>
            </button>
          );
        })}
      </div>
      <Modal open={shown !== null} wide="xl" onClose={() => setOpen(null)} title={shown ? `${shown.author || "Unknown author"} on ${shown.source || "the web"}` : ""}
        footer={shown && open !== null ? (
          <div className="flex w-full items-center gap-2">
            <Button icon={<ChevronLeft className="size-4" />} disabled={open === 0} onClick={() => setOpen(open - 1)}>Previous</Button>
            <Button disabled={open >= posts.length - 1} onClick={() => setOpen(open + 1)}>Next<ChevronRight className="size-4" /></Button>
            <span className="ml-auto text-xs text-zinc-500">{open + 1} of {posts.length}</span>
          </div>
        ) : undefined}>
        {shown && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="min-w-0 space-y-3 text-sm">
              <p className="whitespace-pre-line text-zinc-800 dark:text-zinc-200">{shown.text || "No words came with this post."}</p>
              <KV cols={1} items={[["Posted", shown.at ? fmtDateTime(shown.at) : "not known"], ["Engagement", engagementOf(shown).text],
                ["Sentiment it came with", shown.negative ? "negative" : "not negative"], ...(shown.text_from ? [["Words from", shown.text_from] as [ReactNode, ReactNode]] : [])]} />
              {/^https?:\/\//i.test(shown.url) && <a href={shown.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300">Open the post<ExternalLink className="size-3.5" /></a>}
            </div>
            <div className="min-w-0">
              {frame ? (
                <iframe key={frame.src} src={frame.src} title={`The post on ${frame.site}`} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups"
                  className="w-full rounded-xl border border-zinc-200 bg-white dark:border-zinc-700" style={frame.ratio ? { aspectRatio: String(frame.ratio) } : { height: Math.min(frame.height ?? 560, 640) }} />
              ) : <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">This post can't be shown here. Use Open the post to read it where it was posted.</p>}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/** The write-up's hourly chart as the team sends it: a blue line on white, so it copies into an email or a doc as it is. */
function WriteupChart({ chart, svgRef }: { chart: TcCheck["chart"]; svgRef: RefObject<SVGSVGElement | null> }) {
  const pts = chart.points ?? [];
  if (pts.length < 1) return null;
  const W = 680, H = 300, left = 48, right = 16, top = 40, bottom = 34;
  const most = Math.max(1, ...pts.map((p) => p.n));
  const stepY = Math.pow(10, Math.floor(Math.log10(most))) * (most / Math.pow(10, Math.floor(Math.log10(most))) > 5 ? 2 : most / Math.pow(10, Math.floor(Math.log10(most))) > 2 ? 1 : 0.5);
  const ticks: number[] = [];
  for (let v = 0; v <= most + stepY * 0.999; v += stepY) ticks.push(Math.round(v));
  const max = ticks[ticks.length - 1];
  const x = (i: number) => left + (pts.length > 1 ? (i * (W - left - right)) / (pts.length - 1) : (W - left - right) / 2);
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom);
  const every = pts.length <= 8 ? 1 : pts.length <= 18 ? 3 : pts.length <= 42 ? 6 : pts.length <= 84 ? 12 : 24;
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" className="h-auto max-w-full rounded-xl"
      aria-label={`${chart.title}: ${chart.unit} by hour, from ${fmtNum(pts[0].n)} at ${pts[0].label} to ${fmtNum(pts[pts.length - 1].n)} at ${pts[pts.length - 1].label}`}>
      <rect width={W} height={H} fill="#ffffff" />
      <text x={W / 2} y={22} textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize={15} fontWeight="bold" fill="#000000">{chart.title}</text>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={left} x2={W - right} y1={y(v)} y2={y(v)} stroke="#cccccc" strokeWidth={1} />
          <text x={left - 6} y={y(v) + 4} textAnchor="end" fontFamily="Arial, Helvetica, sans-serif" fontSize={12} fill="#000000">{v.toLocaleString("en-US")}</text>
        </g>
      ))}
      {pts.map((p, i) => (i % every === 0 ? (
        <text key={i} x={x(i)} y={H - 12} textAnchor={pts.length > 1 && i === pts.length - 1 ? "end" : "middle"} fontFamily="Arial, Helvetica, sans-serif" fontSize={11} fill="#000000">{p.label}</text>
      ) : null))}
      <polyline fill="none" stroke={BW} strokeWidth={3} strokeLinejoin="round" points={pts.map((p, i) => `${x(i).toFixed(1)},${y(p.n).toFixed(1)}`).join(" ")} />
    </svg>
  );
}

/** The chart as a PNG (twice its size, so it stays sharp when pasted). */
async function chartPng(svg: SVGSVGElement): Promise<string> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  const img = new Image();
  await new Promise<void>((done, fail) => { img.onload = () => done(); img.onerror = () => fail(new Error("the chart could not be drawn")); img.src = url; });
  const canvas = document.createElement("canvas");
  canvas.width = svg.viewBox.baseVal.width * 2;
  canvas.height = svg.viewBox.baseVal.height * 2;
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function Panel({ title, sub, says, children }: { title: string; sub?: string; says?: string; children: ReactNode }) {
  return (
    <figure className="min-w-0 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
      <figcaption className="mb-3"><span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</span>{sub && <span className="mt-0.5 block text-xs text-zinc-500">{sub}</span>}</figcaption>
      <div role={says ? "img" : undefined} aria-label={says}>{children}</div>
    </figure>
  );
}

/** A ranked list as bars, each with its number written out. */
function Bars({ title, sub, rows, unit, parts = true }: { title: string; sub?: string; rows: (Ranked & { color: string })[]; unit: string; parts?: boolean }) {
  const most = Math.max(1, ...rows.map((r) => r.n));
  const total = parts ? rows.reduce((n, r) => n + r.n, 0) : 0;  // a share is shown only where the rows are parts of one whole
  return (
    <Panel title={title} sub={sub}>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="text-sm">
            <span className="flex justify-between gap-3"><span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">{r.label}</span>
              <span className="shrink-0 tabular-nums text-zinc-500">{fmtNum(Math.round(r.n))} {unit}{total ? ` · ${pctOf(r.n, total)}` : ""}</span></span>
            <span className="mt-1 block h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"><span className="block h-full rounded-full" style={{ width: `${Math.max(r.n ? 2 : 0, (r.n * 100) / most)}%`, background: r.color }} /></span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Ring({ title, parts }: { title: string; parts: (Ranked & { color: string })[] }) {
  const total = parts.reduce((n, p) => n + p.n, 0);
  return (
    <Panel title={title} says={`${title}: ${parts.map((p) => `${p.label} ${fmtNum(p.n)} (${pctOf(p.n, total)})`).join(", ")}`}>
      <div className="flex flex-wrap items-center gap-4">
        <div style={{ width: 132, height: 132 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart><Pie data={parts} dataKey="n" nameKey="label" innerRadius={38} outerRadius={62} stroke="none" isAnimationActive={false}>{parts.map((p) => <Cell key={p.label} fill={p.color} />)}</Pie></PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
          {parts.map((p) => <li key={p.label} className="flex items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color }} /><span className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">{p.label}</span><span className="shrink-0 tabular-nums text-zinc-500">{fmtNum(p.n)} · {pctOf(p.n, total)}</span></li>)}
        </ul>
      </div>
    </Panel>
  );
}

function HoursChart({ hours, to, unit, ours }: { hours: { at: string; n: number }[]; to: string | null; unit: string; ours?: boolean }) {
  const cur = Math.floor((to ? Date.parse(to) : Date.now()) / 3600000) * 3600000;
  const full = hours.filter((h) => Date.parse(h.at) < cur);  // the hour still running can't be the peak yet
  const peak = full.reduce<{ at: string; n: number } | null>((a, b) => (!a || b.n > a.n ? b : a), null);
  const color = (h: { at: string }) => (peak && peak.n > 0 && h.at === peak.at ? (ours ? OURS_PEAK : BW_PEAK) : Date.parse(h.at) >= cur ? (ours ? OURS_SOFT : BW_SOFT) : ours ? OURS : BW);
  return (
    <Panel title={`${unit[0].toUpperCase()}${unit.slice(1)} by hour`} sub="The darkest bar is the peak hour. The pale bar is the hour still running."
      says={`${unit} by hour, ${hours.length} hours${peak && peak.n > 0 ? `; the peak was ${fmtNum(peak.n)} at ${fmtDateTime(peak.at)}` : ""}.`}>
      <div style={{ height: 250 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={hours.map((h) => ({ ...h, label: hourTick(h.at) }))} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
            <CartesianGrid vertical={false} stroke="rgb(128 134 139 / 0.2)" />
            <XAxis dataKey="label" {...axis} minTickGap={36} /><YAxis allowDecimals={false} {...axis} /><ChartTooltip {...tip} />
            <Bar dataKey="n" name={unit} radius={[3, 3, 0, 0]} isAnimationActive={false}>{hours.map((h) => <Cell key={h.at} fill={color(h)} />)}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function Tiles({ items }: { items: ({ label: string; value: ReactNode; hint?: string } | null)[] }) {
  const shown = items.filter((t) => t !== null);
  return (
    <dl className={`grid grid-cols-2 gap-3 ${shown.length === 5 ? "sm:grid-cols-3 2xl:grid-cols-5" : "xl:grid-cols-4"}`}>
      {shown.map((t) => (
        <div key={t.label} className="flex min-w-0 flex-col rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t.label}</dt>
          <dd className="mt-1 text-2xl font-medium tabular-nums tracking-tight text-zinc-950 dark:text-zinc-50">{t.value}</dd>
          {t.hint && <dd className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">{children}</p>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-500 dark:text-zinc-400">{children}</p>;
}

export function TempCheckResult({ c, tables, canAct, busy, onRefresh, onKeep, toast }: {
  c: TcCheck; tables: FormInfo["tables"]; canAct: boolean; busy: string; onRefresh: () => void; onKeep: (action: "keep_refreshed" | "stop_refresh") => void;
  toast: (text: string, tone?: "error") => void;
}) {
  const [tab, setTab] = useState<"writeup" | "numbers" | "own" | "posts">("writeup");
  const svg = useRef<SVGSVGElement>(null);
  const ownPosts = useApi<{ kept: number; posts: TcPost[] }>(tab === "own" && (c.own.kept ?? 0) > 0 ? `/temp-checks/${c.check_id}/own-posts` : null);
  const own = c.basis === "own";
  const bw = c.basis === "brandwatch";
  const unit = own ? "posts" : "mentions";
  const s = c.sentiment;
  const sTotal = (s.positive ?? 0) + (s.neutral ?? 0) + (s.negative ?? 0);
  const v = c.velocity;
  const l = c.level;
  const keeping = !!c.keep_refreshed_until && Date.parse(c.keep_refreshed_until) > Date.now();
  const took = c.completed_at ? Math.max(0, Math.round((Date.parse(c.completed_at) - Date.parse(c.created_at)) / 1000)) : null;
  const [before, after] = c.writeup_html.split("<!--tc-chart-->");
  const types = Object.fromEntries(c.mention_types.map((t) => [t.label, t.n]));
  const ownTotal = c.own.total ?? 0;
  // What the run noted, less what a line below already says in the app's words
  const notes = c.notes.filter((n) => !/^(No concern level:|Built from our own tables:)/.test(n) && n !== c.standing_detail.skipped);

  const copy = async () => {
    try {
      const png = svg.current ? await chartPng(svg.current) : "";
      const html = c.writeup_html.replace("<!--tc-chart-->", png ? `<p><img src="${png}" width="680" alt="${(c.chart.title ?? "").replace(/"/g, "&quot;")}"></p>` : "");
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([c.writeup_text], { type: "text/plain" }) })]);
      toast(png ? "Copied, chart included. Paste it into an email or a doc." : "Copied.");
    } catch {
      try { await navigator.clipboard.writeText(c.writeup_text); toast("Copied as text. The chart could not be copied: use Download chart."); } catch { toast("Could not copy. Select the write-up and copy it by hand.", "error"); }
    }
  };
  const download = async () => {
    if (!svg.current) return;
    try {
      const a = document.createElement("a");
      a.href = await chartPng(svg.current);
      a.download = "temp-check-volume.png";
      document.body.append(a);
      a.click();
      a.remove();
    } catch (err) { toast((err as Error).message, "error"); }
  };

  const numbersTable: [ReactNode, ReactNode][] = [
    ["Counted", `${fmtDateTime(c.window_from)} to ${fmtDateTime(c.window_to)} (from ${WHY[c.start.why ?? ""] ?? (own || c.standing ? "the day before the alert" : "as far back as it looks")})`],
    [`Total ${unit}`, fmtNum(c.total)],
    ...(c.update ? [["Since the last update", `${fmtNum(Math.max(0, c.total - c.update.total))} new (it had ${fmtNum(c.update.total)} at ${fmtDateTime(c.update.at)})`] as [ReactNode, ReactNode]] : []),
    ["Peak hour", v ? `${fmtNum(v.peak.n)} at ${fmtDateTime(v.peak.at)}` : "too early to tell"],
    ["Last full hour", v ? `${fmtNum(v.last.n)} (${v.pct}% against the peak)` : "too early to tell"],
    ["Sentiment", sTotal ? `negative ${fmtNum(s.negative ?? 0)} (${pctOf(s.negative ?? 0, sTotal)}) · neutral ${fmtNum(s.neutral ?? 0)} (${pctOf(s.neutral ?? 0, sTotal)}) · positive ${fmtNum(s.positive ?? 0)} (${pctOf(s.positive ?? 0, sTotal)})` : "not scored"],
    ["By source", ranked(c.sources, c.total)],
    ["Mention types", c.mention_types.length ? ranked(c.mention_types, c.total) : "not in our own tables"],
    ["Engagement by source", ranked(c.eng_sources)],
    ...(c.coverage.x ? [["Words of X posts", `${c.coverage.x} X posts among Brandwatch's ${c.coverage.ranked} top posts: ${c.coverage.from_embed} from X's embed data, ${c.coverage.in_rows} were in our own rows, ${c.coverage.no_words} with no words anywhere`] as [ReactNode, ReactNode]] : []),
  ];
  const per100 = (of: number) => ((ownTotal * 100) / of).toFixed(ownTotal * 100 < of * 10 ? 1 : 0);
  const aligned = (() => {
    const by = new Map<string, { at: string; bw: number; ours: number | null }>();
    c.hours.forEach((h) => by.set(h.at, { at: h.at, bw: h.n, ours: null }));
    (c.own.hours ?? []).forEach((h) => { const row = by.get(h.at) ?? { at: h.at, bw: 0, ours: null }; row.ours = h.n; by.set(h.at, row); });
    return [...by.values()].sort((a, b) => a.at.localeCompare(b.at)).map((r) => ({ ...r, label: hourTick(r.at) }));
  })();
  const report: ConvertResult = { boolean: c.own.boolean ?? "", origin: c.own.origin ?? "", ok: !c.own.error, error: c.own.error ?? "", plan: "", report: c.query.report ?? null };

  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "writeup", label: "Write-up" }, { key: "numbers", label: "Numbers" }, { key: "own", label: "Our data next to Brandwatch" }, { key: "posts", label: "Posts read", count: c.read_posts.length }]} />

      {tab === "writeup" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={<Copy className="size-4" />} disabled={!c.writeup_text} onClick={copy}>Copy write-up</Button>
            <Button icon={<Download className="size-4" />} disabled={!(c.chart.points ?? []).length} onClick={download}>Download chart</Button>
            <Button icon={<RefreshCw className="size-4" />} disabled={!canAct} loading={busy === "refresh"} onClick={onRefresh}>Refresh (send as an update)</Button>
            {keeping
              ? <Button disabled={!canAct} loading={busy === "stop_refresh"} onClick={() => onKeep("stop_refresh")} title={`Refreshed every hour until ${fmtDateTime(c.keep_refreshed_until)}`}>Stop refreshing</Button>
              : <Button disabled={!canAct} loading={busy === "keep_refreshed"} onClick={() => onKeep("keep_refreshed")} title="A refresh every hour for the next day, whether or not automatic temp checks are on">Keep refreshed for a day</Button>}
            <span className="ml-auto text-xs text-zinc-500">{fmtDateTime(c.created_at)}{took !== null ? ` · took ${took} s` : ""}</span>
          </div>
          {l.label ? (
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              <b>Concern level: {l.label}</b> · {l.action} · {l.side} {l.pct}% of {fmtNum(l.n ?? 0)} past issues
              {l.known && !l.full_year ? ` (Brandwatch lists ${fmtNum(l.known)} for the past 12 months; the rest are deactivated and can't be read)` : ""}, each compared at {l.hours} hours in.
              {" "}This is the app's own ranking: check it against the team's benchmark until the two have been compared.
            </p>
          ) : <Warn>No concern level in this write-up: {l.why || "there is nothing to rank it against yet."}</Warn>}
          {c.gem.why && c.total > 0 && <Warn>Gemini's lines were not written: {c.gem.why}.</Warn>}
          {notes.map((n) => <Note key={n}>{n}</Note>)}
          {bw && c.standing && (
            <Note>This issue has no Brandwatch query of its own yet. The counts are Brandwatch's own, from its {fmtNum(c.standing_detail.queries ?? 0)} standing Google queries searched with the query shown on the "Our data" tab.
              They count only mentions those queries already hold (ones that name Google or one of its products), so a query built for the issue can count differently.</Note>
          )}
          {own && <Warn>This one is built from our own tables only{c.standing_detail.skipped ? `: ${c.standing_detail.skipped}` : " (no Brandwatch query)."} Its counts are posts, not Brandwatch mentions.</Warn>}
          {!c.total && <Warn>Nothing was counted. Try a wider query (fewer words that must all be there), a longer stretch under "Count from", or look at how the query converted on the "Our data" tab.</Warn>}
          {c.query.widened && <Warn>{c.query.widened.why}</Warn>}
          {c.query.pct !== null && c.query.pct !== undefined && c.query.pct < 100 && <Warn>Brandwatch is still filling this query ({Math.round(c.query.pct)}% done), so the counts will grow.</Warn>}
          <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
            <SafeHtml html={before ?? ""} className="prose-plain text-zinc-800 dark:text-zinc-200" />
            {after !== undefined && <div className="my-4"><WriteupChart chart={c.chart} svgRef={svg} /></div>}
            {after !== undefined && <SafeHtml html={after} className="prose-plain text-zinc-800 dark:text-zinc-200" />}
          </div>
        </div>
      )}

      {tab === "numbers" && (
        <div className="space-y-4">
          {c.total > 0 && <>
            <Tiles items={[
              { label: `Total ${unit}`, value: fmtNum(c.total), hint: `${fmtDateTime(c.window_from)} to ${fmtDateTime(c.window_to)}` },
              { label: "Peak hour", value: v ? fmtNum(v.peak.n) : "too early", hint: v ? fmtDateTime(v.peak.at) : "the first full hour isn't over" },
              { label: "Last full hour", value: v ? fmtNum(v.last.n) : "too early", hint: v ? `${v.pct > 0 ? "+" : ""}${v.pct}% against the peak` : "" },
              { label: "Negative", value: sTotal ? pctOf(s.negative ?? 0, sTotal) : "not scored", hint: sTotal ? `${fmtNum(s.negative ?? 0)} of the ${fmtNum(sTotal)} scored` : "" },
              c.update ? { label: "Since the last update", value: `+${fmtNum(Math.max(0, c.total - c.update.total))}`, hint: `it had ${fmtNum(c.update.total)} at ${fmtDateTime(c.update.at)}` } : null,
            ]} />
            <HoursChart hours={c.hours} to={c.window_to} unit={unit} ours={own} />
            <div className="grid gap-4 lg:grid-cols-2">
              {sTotal > 0 && <Ring title="Sentiment" parts={[{ label: "Negative", n: s.negative ?? 0, color: TONES.negative }, { label: "Neutral", n: s.neutral ?? 0, color: TONES.neutral }, { label: "Positive", n: s.positive ?? 0, color: TONES.positive }]} />}
              {c.mention_types.length > 0 && <Ring title="Mention types" parts={c.mention_types.map((t) => ({ label: t.label[0].toUpperCase() + t.label.slice(1), n: t.n, color: TYPES[t.label] ?? OTHER }))} />}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {c.sources.length > 0 && <Bars title={`${unit[0].toUpperCase()}${unit.slice(1)} by source`} unit={unit} rows={topWithOther(c.sources, 8).map((x) => ({ ...x, color: PLATFORM[x.label] ?? OTHER }))} />}
              {c.eng_sources.length > 0 && <Bars title="Engagement by source" sub="Likes, comments and shares on the posts counted." unit="engagements" rows={topWithOther(c.eng_sources, 8).map((x) => ({ ...x, color: PLATFORM[x.label] ?? OTHER }))} />}
            </div>
            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">The same numbers as a table</h3>
          </>}
          <KV cols={1} items={numbersTable} />
          <details>
            <summary className="cursor-pointer text-sm text-blue-700 dark:text-blue-300">Each hour's count</summary>
            <pre className={PRE}>{c.hours.map((h) => `${hourTick(h.at)}\t${h.n}`).join("\n")}</pre>
          </details>
        </div>
      )}

      {tab === "own" && (c.own_total === null && !c.own.error ? (
        <div className="space-y-3">
          <Note>Our own tables were not searched for this one. Turn on "Also search our own tables" on the form to set them beside Brandwatch.</Note>
          {c.query.boolean && <pre className={PRE}>{c.query.boolean}</pre>}
        </div>
      ) : c.own.error ? (
        <div className="space-y-3"><Alert tone="rose">{c.own.error}</Alert>{c.query.report && <ConvertReport r={report} tables={tables} />}</div>
      ) : (
        <div className="space-y-4">
          <Tiles items={[
            bw ? { label: c.standing ? "Brandwatch counted, in its standing Google queries" : "Brandwatch counted", value: <span style={{ color: BW }}>{fmtNum(c.total)}</span>, hint: "mentions" } : null,
            { label: "Our own tables hold", value: <span style={{ color: OURS }}>{fmtNum(ownTotal)}</span>, hint: "posts and comments, each counted once" },
            bw && c.total ? { label: "Our posts for every 100 Brandwatch mentions", value: per100(c.total), hint: "not a share: the two are different sets" } : null,
            bw && types["original posts"] ? { label: "Our posts for every 100 of Brandwatch's original posts", value: per100(types["original posts"]), hint: "the fairer comparison: our tables hold no reposts" } : null,
          ]} />
          {bw && c.total > 0 && ownTotal > 0 ? (
            <Panel title="Hour by hour: Brandwatch's mentions and the posts in our tables" says={`Brandwatch's mentions and our tables' posts by hour, ${aligned.length} hours.`}
              sub="Two scales: read the bars on the left and the line on the right. A line that rises and falls with the bars means our tables follow the conversation; a flat line under tall bars means they miss it.">
              <div style={{ height: 290 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={aligned} margin={{ top: 4, right: 0, bottom: 0, left: -6 }}>
                    <CartesianGrid vertical={false} stroke="rgb(128 134 139 / 0.2)" />
                    <XAxis dataKey="label" {...axis} minTickGap={36} /><YAxis yAxisId="bw" allowDecimals={false} {...axis} /><YAxis yAxisId="ours" orientation="right" allowDecimals={false} {...axis} />
                    <ChartTooltip {...tip} /><Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar yAxisId="bw" dataKey="bw" name="Brandwatch mentions (left scale)" fill={BW} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Line yAxisId="ours" dataKey="ours" name="Posts in our tables (right scale)" stroke={OURS} strokeWidth={3} dot={false} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          ) : ownTotal > 0 ? <HoursChart hours={c.own.hours ?? []} to={c.window_to} unit="posts in our tables" ours /> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            {bw && c.total > 0 && (
              <Bars title="The two counts, piece by piece" unit="" parts={false} sub="Our tables hold posts, not reposts, so set the orange bar beside the first blue one."
                rows={[{ label: "Brandwatch: original posts", n: types["original posts"] ?? 0, color: BW }, { label: "Brandwatch: comments and replies", n: types.comments ?? 0, color: "#7baaf7" },
                  { label: "Brandwatch: reposts", n: types.reposts ?? 0, color: BW_SOFT }, { label: "Our tables: posts and comments", n: ownTotal, color: OURS }]} />
            )}
            <Bars title="What each of our tables found" unit="matched" parts={false} sub="Before a post that is in two tables is counted once."
              rows={c.tables.map((t, i) => ({ label: t.skipped || t.error ? `${t.label} (skipped)` : t.label, n: t.matched ?? 0, color: [OURS, "#f6b04d", "#e37400", "#fbd08a", OURS_PEAK][i % 5] }))} />
          </div>
          {!bw && (c.own.sources ?? []).length > 0 && <Bars title="Our posts by source" unit="posts" rows={topWithOther(c.own.sources, 9).map((x) => ({ ...x, color: PLATFORM[x.label] ?? OTHER }))} />}
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">The same numbers as a table</h3>
          <KV cols={1} items={[
            ...(bw ? [["Brandwatch: mentions", fmtNum(c.total)], ["Brandwatch: original posts", fmtNum(types["original posts"] ?? 0)], ["Brandwatch: comments and replies", fmtNum(types.comments ?? 0)], ["Brandwatch: reposts", fmtNum(types.reposts ?? 0)]] as [ReactNode, ReactNode][] : []),
            ["Our tables: posts and comments", fmtNum(ownTotal)],
            ...c.tables.map((t) => [t.label, t.skipped ? `skipped: ${t.skipped}` : t.error ? `failed: ${t.error}` : `${fmtNum(t.matched ?? 0)} matched${t.scan_gb !== undefined ? `, ${t.scan_gb} GB scanned` : ""}${t.freshness ? `, ${t.freshness}` : ""}`] as [ReactNode, ReactNode]),
            ["Our posts by source", ranked(c.own.sources, ownTotal)],
          ]} />
          {bw && <Note>Our tables hold posts, not the reposts of and replies to them, so set our count beside Brandwatch's original posts, not its total. The two are not the same set of posts: each side has some the other lacks.</Note>}
          {c.own.reused && <Note>Reused {fmtNum(c.own.reused.kept)} posts gathered at {fmtDateTime(c.own.reused.gathered_at)}; searched afresh only for what came after ({fmtNum(c.own.reused.since)} found). {c.own.reused.note}</Note>}
          {c.query.drafted && <Note>The query was drafted from the alert: Gemini named what it is about and the words people use about it, and the app joined them. {c.query.draft_why}</Note>}
          {c.query.widened && <Warn>{c.query.widened.why} The drafted query was: {c.query.widened.from}</Warn>}
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">How the query was converted</h3>
          <ConvertReport r={report} tables={tables} />
          <details>
            <summary className="cursor-pointer text-sm text-blue-700 dark:text-blue-300">The query that was searched</summary>
            <pre className={PRE}>{c.own.boolean}</pre>
          </details>
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Posts found {ownPosts.data ? `(the ${Math.min(60, ownPosts.data.posts.length)} with the most engagement of ${fmtNum(ownPosts.data.kept)} kept)` : ""}</h3>
          <Note>Open a card to read the post without leaving the Console. The bar on each card is its engagement against the most-engaged one here.</Note>
          {ownPosts.data ? <PostGrid posts={ownPosts.data.posts} /> : (c.own.kept ?? 0) > 0 ? <Note>Loading the posts…</Note> : <Note>No posts were kept with this temp check.</Note>}
        </div>
      ))}

      {tab === "posts" && (
        <div className="space-y-3">
          <Note>The {c.read_posts.length} posts Gemini read, in order. A link in the write-up's Negativity Drivers or Themes points at one of these. Open a card to read the post without leaving the Console.</Note>
          <PostGrid posts={c.read_posts} />
        </div>
      )}
    </div>
  );
}
