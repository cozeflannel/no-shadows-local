import { Bell, BellOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";

import { useApp } from "../context";
import { SOURCE_LABEL } from "../lib/labels";
import { useArrivals, type LiveItem } from "../lib/live";
import { Switch } from "./ui";

interface Prefs { on: boolean; sound: boolean; desktop: boolean }
interface Popup { id: string; caseId: string | null; title: string; name: string; facts: string }

const KEY = "console-alerts";
const DEFAULTS: Prefs = { on: true, sound: false, desktop: false };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
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

/** Pop-ups for alerts as they come in, on every page, and the bell that turns them on or off for this person. */
export function AlertPopups() {
  const { meta, me } = useApp();
  const rules = meta?.notifications;
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [open, setOpen] = useState(false);
  const [popups, setPopups] = useState<Popup[]>([]);
  const timers = useRef(new Map<string, number>());
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  }, [prefs]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [open]);

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
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog"
          aria-label={active ? "Alert pop-ups are on" : "Alert pop-ups are off"} title="Alert pop-ups"
          className="rounded-full p-2 text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {active ? <Bell className="size-4" /> : <BellOff className="size-4" />}
        </button>
        {open && (
          <div role="dialog" aria-label="Alert pop-ups" className="absolute right-0 top-11 z-40 w-72 rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Alert pop-ups</p>
            {!rules?.enabled ? (
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                Switched off for everyone.{" "}
                {me?.is_admin ? <Link to="/settings/flags" onClick={() => setOpen(false)} className="text-blue-700 underline dark:text-blue-300">Turn on Alert pop-ups</Link> : "An admin can turn them on in Settings."}
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-3 text-sm text-zinc-700 dark:text-zinc-300">
                <div className="flex items-center justify-between gap-3">Show them to me<Switch label="Show alert pop-ups to me" checked={prefs.on} onChange={(on) => setPrefs((p) => ({ ...p, on }))} /></div>
                <div className="flex items-center justify-between gap-3">Play a sound<Switch label="Play a sound" checked={prefs.sound} disabled={!prefs.on} onChange={(sound) => { setPrefs((p) => ({ ...p, sound })); if (sound) chime(); }} /></div>
                <div className="flex items-center justify-between gap-3">Notify me when this tab is hidden<Switch label="Notify me when this tab is hidden" checked={prefs.desktop} disabled={!prefs.on || blocked} onChange={setDesktop} /></div>
                {blocked && <p className="text-xs text-zinc-500">This browser blocks notifications from this site. Allow them in the address bar to use this.</p>}
              </div>
            )}
          </div>
        )}
      </div>
      {createPortal(
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5">
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
