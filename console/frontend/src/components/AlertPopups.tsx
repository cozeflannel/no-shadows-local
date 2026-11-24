import { Bell, BellOff, Check, CheckCheck, ChevronDown, ExternalLink, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";

import { useApp } from "../context";
import { fmtDateTime, fmtRelative } from "../lib/format";
import { SOURCE_LABEL, STATUS_LABEL } from "../lib/labels";
import { useArrivals, useLive, type LiveItem } from "../lib/live";
import { cx, Switch } from "./ui";

interface Prefs { on: boolean; sound: boolean; desktop: boolean }
interface Popup { id: string; caseId: string | null; title: string; name: string; facts: string }
interface ReadState { before: string; ids: string[] }

const KEY = "console-alerts";
const READ_KEY = "console-bell-read";
const DEFAULTS: Prefs = { on: true, sound: false, desktop: false };
const KEPT_IDS = 300;

// What the bell lists: things that happened to alerts and problems a person may need to act on. Housekeeping (a
// message received, a field corrected, an alert updated) stays out so the list reads as a short history.
const BELL_TYPES = new Set([
  "triage.passed", "triage.corrected", "triage.needs_review", "triage.failed", "triage.suppressed", "sla.at_risk", "sla.missed",
  "review.forwarded", "review.bounced", "review.suppressed", "email.drafted", "email.sent", "tns.submitted", "parity.unmatched",
  "safety.blocked", "outbound.dead_lettered", "temp_check.completed", "temp_check.failed", "workforce.gap_alert", "velocity.spike", "error",
]);
const WHAT: Record<string, string> = {
  "triage.passed": "Passed as sent", "triage.corrected": "Fixed by the agent and posted", "triage.needs_review": "Held for an IM to review",
  "triage.failed": "Sent back to Burson", "triage.suppressed": "No alert needed", "sla.at_risk": "SLA at risk", "sla.missed": "SLA missed",
  "review.forwarded": "Forwarded after review", "review.bounced": "Sent back to Burson after review", "review.suppressed": "Suppressed after review",
  "email.drafted": "Social Alert draft ready", "email.sent": "Social Alert email sent", "tns.submitted": "Trust & Safety report submitted",
  "parity.unmatched": "Only one side alerted", "velocity.spike": "Post velocity spike",
};
const NEEDS: Record<string, string> = { sla: "SLA at risk: needs an IM now", review: "Waiting for an IM to review", acknowledge: "Waiting for an IM to react", source_fix: "Waiting for Burson's fix" };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

function loadRead(): ReadState {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? "null") as ReadState | null;
    if (raw && typeof raw.before === "string" && Array.isArray(raw.ids)) return raw;
  } catch { /* private mode */ }
  return { before: new Date().toISOString(), ids: [] }; // the first visit starts with nothing unread
}

/** Two short tones, made in the browser (no sound file). */
function chime(): void {
  try {
    const audio = new AudioContext();
    [660, 880].forEach((hz, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.16 + 0.15);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + i * 0.16);
      osc.stop(audio.currentTime + i * 0.16 + 0.16);
    });
    window.setTimeout(() => void audio.close(), 700);
  } catch {
    /* the browser blocked sound until the page is clicked */
  }
}

function popupOf(item: LiveItem): Popup {
  const source = String(item.payload.source ?? "burson_chat");
  const from = source === "burson_chat" ? "Burson" : (SOURCE_LABEL[source] ?? source);
  const c = item.case;
  return {
    id: item.event_id, caseId: item.case_id, title: `New alert from ${from}`,
    name: c?.alert_name ?? item.case_id ?? "Alert received",
    facts: [c?.product, c?.priority, c?.track === "URGENT" ? "Urgent" : null].filter(Boolean).join(" · "),
  };
}

/** One plain line: what happened, and to which alert. */
function lineOf(item: LiveItem): string {
  const name = item.case?.alert_name || item.case_id;
  const what = WHAT[item.event_type];
  if (what) return name ? `${what}: ${name}` : (item.summary || what);
  return item.summary || item.event_type.replace(/[._]/g, " ");
}

/** Where "Open" goes, when the thing has a page. */
function pageOf(item: LiveItem): string | null {
  if (item.event_type === "velocity.spike" && item.payload.post_key) return `/velocity?focus=${encodeURIComponent(String(item.payload.post_key))}`;
  if (item.case_id) return `/feed/${item.case_id}`;
  if (item.event_type.startsWith("temp_check.") && item.payload.check_id) return `/temp-check/${String(item.payload.check_id)}`;
  if (item.event_type === "safety.blocked") return "/settings/safety";
  if (item.event_type === "outbound.dead_lettered") return "/settings/pubsub";
  if (item.event_type === "workforce.gap_alert") return "/workforce";
  return null;
}

function Preview({ item, onOpen }: { item: LiveItem; onOpen: () => void }) {
  const c = item.case;
  const to = pageOf(item);
  const facts: [string, string | null | undefined][] = [
    ["Alert", c?.alert_name ?? item.case_id], ["Product", c?.product], ["Priority", c?.priority],
    ["Track", c?.track === "URGENT" ? "Urgent" : c?.track === "HIGH_ENGAGEMENT" ? "High engagement" : c?.track],
    ["Now", c ? (STATUS_LABEL[c.status] ?? c.status) : null], ["By", item.actor && item.actor !== "agent" ? item.actor : null],
    ["When", fmtDateTime(item.event_ts)],
  ];
  return (
    <div className="mt-2 rounded-xl bg-zinc-50 p-3 text-xs dark:bg-zinc-800/60">
      {item.needs && NEEDS[item.needs] && <p className="mb-2 font-medium text-rose-700 dark:text-rose-300">{NEEDS[item.needs]}</p>}
      {item.summary && <p className="mb-2 break-words text-zinc-700 dark:text-zinc-300">{item.summary}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {facts.filter(([, v]) => !!v).map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="min-w-0 break-words text-zinc-800 dark:text-zinc-200">{v}</dd></div>
        ))}
      </dl>
      {to && (
        <Link to={to} onClick={onOpen} className="mt-3 inline-flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700 dark:bg-blue-200 dark:text-blue-900 dark:hover:bg-blue-100">
          Open<ExternalLink className="size-3" aria-hidden />
        </Link>
      )}
    </div>
  );
}

/** The bell: what happened lately (read and unread), a preview of each without leaving the page, and the pop-ups for new alerts. */
export function AlertPopups() {
  const { meta, me } = useApp();
  const rules = meta?.notifications;
  const live = useLive(120);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [read, setRead] = useState<ReadState>(loadRead);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [popups, setPopups] = useState<Popup[]>([]);
  const timers = useRef(new Map<string, number>());
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  }, [prefs]);
  useEffect(() => {
    try { localStorage.setItem(READ_KEY, JSON.stringify(read)); } catch { /* private mode */ }
  }, [read]);
  const close = useCallback((refocus = true) => {
    setOpen(false);
    setExpanded(null);
    if (refocus) button.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node)) close(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    window.setTimeout(() => panel.current?.focus(), 0);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key); };
  }, [open, close]);

  const items = useMemo(() => live.items.filter((i) => BELL_TYPES.has(i.event_type)).slice(0, 60), [live.items]);
  const isUnread = useCallback((i: LiveItem) => i.event_ts > read.before && !read.ids.includes(i.event_id), [read]);
  const unread = items.filter(isUnread).length;
  const markRead = (id: string) => setRead((r) => (r.ids.includes(id) ? r : { ...r, ids: [id, ...r.ids].slice(0, KEPT_IDS) }));
  const markAll = () => setRead({ before: items[0]?.event_ts && items[0].event_ts > new Date().toISOString() ? items[0].event_ts : new Date().toISOString(), ids: [] });

  const dismiss = useCallback((id: string) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setPopups((old) => old.filter((p) => p.id !== id));
  }, []);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const active = !!rules?.enabled && prefs.on;
  useArrivals((batch) => {
    if (!active || !rules) return;
    const fresh = batch.filter((i) => rules.event_types.includes(i.event_type) && rules.sources.includes(String(i.payload.source ?? "burson_chat"))).map(popupOf);
    if (!fresh.length) return;
    setPopups((old) => [...fresh, ...old].slice(0, rules.max_on_screen));
    fresh.forEach((p) => timers.current.set(p.id, window.setTimeout(() => dismiss(p.id), rules.seconds * 1000)));
    if (prefs.sound) chime();
    if (prefs.desktop && document.hidden && "Notification" in window && Notification.permission === "granted") {
      fresh.forEach((p) => new Notification(p.title, { body: [p.name, p.facts].filter(Boolean).join("\n"), tag: p.id }));
    }
  });

  const setDesktop = (on: boolean) => {
    if (!on || !("Notification" in window)) return setPrefs((p) => ({ ...p, desktop: false }));
    void Notification.requestPermission().then((answer) => setPrefs((p) => ({ ...p, desktop: answer === "granted" })));
  };
  const blocked = "Notification" in window && Notification.permission === "denied";

  return (
    <>
      <div className="relative" ref={menu}>
        <button ref={button} type="button" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open} aria-haspopup="dialog"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} title="Notifications"
          className="relative rounded-full p-2 text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {active || !rules?.enabled ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-medium tabular-nums leading-none text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
        {open && (
          <div ref={panel} tabIndex={-1} role="dialog" aria-label="Notifications"
            className="absolute right-0 top-11 z-40 flex max-h-[min(36rem,calc(100dvh-5rem))] w-[min(26rem,calc(100vw-1.5rem))] flex-col rounded-2xl border border-zinc-200 bg-white shadow-xl outline-none dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <p className="flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">Notifications{unread ? <span className="ml-1.5 text-xs font-normal text-zinc-500">{unread} unread</span> : null}</p>
              <button type="button" onClick={markAll} disabled={!unread}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-200 dark:hover:bg-zinc-800">
                <CheckCheck className="size-3.5" aria-hidden />Mark all as read
              </button>
              <button type="button" onClick={() => setSettings((s) => !s)} aria-expanded={settings} aria-label="Pop-up settings" title="Pop-up settings"
                className={cx("rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800", settings ? "text-blue-700 dark:text-blue-200" : "text-zinc-500")}>
                <Settings2 className="size-4" />
              </button>
            </div>
            {settings && (
              <div className="border-b border-zinc-100 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
                <p className="mb-2 text-xs font-medium text-zinc-500">Pop-ups when a new alert comes in</p>
                {!rules?.enabled ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Switched off for everyone.{" "}
                    {me?.is_admin ? <Link to="/settings/flags" onClick={() => close(false)} className="text-blue-700 underline dark:text-blue-300">Turn on Alert pop-ups</Link> : "An admin can turn them on in Settings."}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-3">Show them to me<Switch label="Show alert pop-ups to me" checked={prefs.on} onChange={(on) => setPrefs((p) => ({ ...p, on }))} /></div>
                    <div className="flex items-center justify-between gap-3">Play a sound<Switch label="Play a sound" checked={prefs.sound} disabled={!prefs.on} onChange={(sound) => { setPrefs((p) => ({ ...p, sound })); if (sound) chime(); }} /></div>
                    <div className="flex items-center justify-between gap-3">Notify me when this tab is hidden<Switch label="Notify me when this tab is hidden" checked={prefs.desktop} disabled={!prefs.on || blocked} onChange={setDesktop} /></div>
                    {blocked && <p className="text-xs text-zinc-500">This browser blocks notifications from this site. Allow them in the address bar to use this.</p>}
                  </div>
                )}
              </div>
            )}
            {items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-zinc-500">Nothing in the last few hours. New alerts and problems show here as they happen.</p>
            ) : (
              <ul className="scroll-thin flex-1 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
                {items.map((i) => {
                  const fresh = isUnread(i);
                  const on = expanded === i.event_id;
                  return (
                    <li key={i.event_id} className={cx("px-4 py-2.5", fresh && "bg-blue-50/60 dark:bg-blue-200/5")}>
                      <div className="flex items-start gap-2">
                        <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", fresh ? "bg-blue-600 dark:bg-blue-300" : "bg-transparent")} aria-hidden />
                        <button type="button" onClick={() => { setExpanded(on ? null : i.event_id); markRead(i.event_id); }} aria-expanded={on}
                          className="min-w-0 flex-1 text-left">
                          <span className={cx("block truncate text-sm", fresh ? "font-medium text-zinc-900 dark:text-zinc-50" : "text-zinc-700 dark:text-zinc-300")} title={lineOf(i)}>{lineOf(i)}</span>
                          <span className="block text-xs text-zinc-500" title={fmtDateTime(i.event_ts)}>{fmtRelative(i.event_ts)}</span>
                        </button>
                        {fresh ? (
                          <button type="button" onClick={() => markRead(i.event_id)} aria-label="Mark as read" title="Mark as read"
                            className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><Check className="size-3.5" /></button>
                        ) : <ChevronDown className={cx("mt-1 size-3.5 shrink-0 text-zinc-400 transition-transform", on && "rotate-180")} aria-hidden />}
                      </div>
                      {on && <div className="pl-4"><Preview item={i} onOpen={() => close(false)} /></div>}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
              {live.state === "live" ? "Up to date, as things happen." : live.state === "connecting" ? "Connecting…" : "Reconnecting…"}
            </p>
          </div>
        )}
      </div>
      {createPortal(
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-3 bottom-20 z-[94] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:bottom-24">
        {popups.map((p) => (
          <div key={p.id} className="glow glow-live pointer-events-auto w-full rounded-2xl bg-white p-4 shadow-2xl sm:w-96 dark:bg-zinc-900">
            <div className="flex items-start gap-3">
              <span className="bg-spark mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-white"><Bell className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{p.title}</p>
                <p className="mt-0.5 line-clamp-2 text-sm font-medium text-zinc-900 dark:text-zinc-50">{p.name}</p>
                {p.facts && <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{p.facts}</p>}
                {p.caseId && (
                  <Link to={`/feed/${p.caseId}`} onClick={() => dismiss(p.id)}
                    className="mt-2 inline-flex rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 dark:bg-blue-200 dark:text-blue-900 dark:hover:bg-blue-100">
                    Open alert
                  </Link>
                )}
              </div>
              <button type="button" onClick={() => dismiss(p.id)} aria-label="Dismiss" className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-4" /></button>
            </div>
          </div>
        ))}
      </div>, document.body)}
    </>
  );
}
