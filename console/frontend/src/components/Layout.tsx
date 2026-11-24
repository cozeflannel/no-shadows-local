import {
  BookOpen, BrainCircuit, CalendarClock, ChevronDown, CircleHelp, FileClock, Inbox, LayoutDashboard, Mail, Megaphone, Menu, MessagesSquare, Moon,
  PanelLeftClose, PanelLeftOpen, Plug, Radar, Route, Scale, Settings, ShieldCheck, Siren, Sparkles, Sun, Thermometer, TrendingUp, UsersRound, Waypoints,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { useApp } from "../context";
import { AlertPopups } from "./AlertPopups";
import { ChatWidget } from "./ChatWidget";
import { GmailButton } from "./GmailButton";
import { cx } from "./ui";

interface NavItem { to: string; label: string; icon: ReactNode; count?: number; hint?: string }
interface NavGroup { label: string; items: NavItem[] }

/** The Help topic that goes with each page (the first path segment). */
const HELP_TOPIC: Record<string, string> = {
  "": "dashboard", feed: "review-feed", chat: "chat-spaces", agent: "chat-agent", "temp-check": "temp-check", velocity: "velocity", workforce: "workforce",
  rosters: "rosters", knowledge: "knowledge", campaigns: "campaigns", cases: "cases", escalations: "cases", settings: "settings",
  suppressed: "cases", parity: "cases", learning: "knowledge", outbox: "delivery", activity: "audit", help: "getting-started",
  stories: "stories", compare: "compare", connections: "integrations", admin: "admin", early: "early-detection", routing: "routing", ai: "ai",
  "own-alerts": "agent-alerts",
};

export function helpPathFor(pathname: string): string {
  const [first, second] = pathname.split("/").filter(Boolean);
  if (first === "settings" && second) {
    const byPart: Record<string, string> = { flags: "feature-flags", secrets: "secrets", bigquery: "bigquery", pubsub: "delivery", prompts: "ai-behavior",
      safety: "safety", audit: "audit", costs: "costs", gcp: "deploy", early: "early-detection", own_alerts: "agent-alerts" };
    return `/help/${byPart[second] ?? "settings"}`;
  }
  return `/help/${HELP_TOPIC[first ?? ""] ?? "getting-started"}`;
}

/** True from the `lg` breakpoint up: the menu sits beside the page. Below it the menu is a drawer. */
function useWide(): boolean {
  const query = "(min-width: 1024px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const on = () => setWide(media.matches);
    media.addEventListener("change", on);
    return () => media.removeEventListener("change", on);
  }, []);
  return wide;
}

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="mark-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4285f4" /><stop offset=".5" stopColor="#9b72cb" /><stop offset="1" stopColor="#d96570" />
        </linearGradient>
      </defs>
      <path fill="url(#mark-g)" d="M16 2c1.1 7.6 6.4 12.9 14 14-7.6 1.1-12.9 6.4-14 14-1.1-7.6-6.4-12.9-14-14 7.6-1.1 12.9-6.4 14-14z" />
    </svg>
  );
}

function Item({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <NavLink to={item.to} end={item.to === "/"} title={collapsed ? item.label : item.hint}
      className={({ isActive }) => cx("flex items-center gap-3 rounded-full px-3 py-2 text-sm transition-colors",
        collapsed && "justify-center px-0",
        isActive ? "bg-blue-100 font-medium text-blue-800 dark:bg-blue-200/15 dark:text-blue-200" : "text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800")}>
      <span className="shrink-0">{item.icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {!collapsed && !!item.count && <span className="rounded-full bg-rose-500 px-1.5 text-xs font-medium tabular-nums text-white">{item.count}</span>}
      {collapsed && !!item.count && <span className="sr-only">{item.count} waiting</span>}
    </NavLink>
  );
}

function GroupLabel({ children, collapsed }: { children: ReactNode; collapsed: boolean }) {
  if (collapsed) return null;
  return <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-500">{children}</p>;
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, counts, theme, toggleTheme } = useApp();
  const location = useLocation();
  const wide = useWide();
  const [folded, setFolded] = useState(() => {
    try { return localStorage.getItem("console-nav") === "collapsed"; } catch { return false; }
  });
  const [drawer, setDrawer] = useState(false);
  const [more, setMore] = useState(false);
  const [setupOpen, setSetupOpen] = useState(() => {
    try { return localStorage.getItem("console-nav-setup") !== "closed"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("console-nav", folded ? "collapsed" : "open"); } catch { /* private mode */ }
  }, [folded]);
  useEffect(() => {
    try { localStorage.setItem("console-nav-setup", setupOpen ? "open" : "closed"); } catch { /* private mode */ }
  }, [setupOpen]);
  useEffect(() => { setDrawer(false); }, [location.pathname, location.search]);
  const collapsed = folded && wide; // the drawer always shows labels

  const icon = "size-[18px]";
  // The analyst's day first; rarely used records fold away; setup pages (admins and leads) sit at the bottom.
  const groups: NavGroup[] = [
    { label: "Daily work", items: [
      { to: "/", label: "Dashboard", icon: <LayoutDashboard className={icon} />, hint: "Alert messages, filters and response times" },
      { to: "/feed", label: "Review feed", icon: <Inbox className={icon} />, count: counts.review, hint: "Alerts waiting for someone, and every alert" },
      { to: "/stories", label: "Stories", icon: <Waypoints className={icon} />, hint: "Alerts on the same story, grouped" },
      { to: "/agent", label: "Ask Gemini", icon: <Sparkles className={icon} />, hint: "The Console chat agent" },
      { to: "/chat", label: "Chat spaces", icon: <MessagesSquare className={icon} />, hint: "What the agent read and posted in Chat" },
    ] },
    { label: "Look into", items: [
      { to: "/temp-check", label: "Temp check", icon: <Thermometer className={icon} />, hint: "How big a conversation is, right now" },
      { to: "/velocity", label: "Post velocity", icon: <TrendingUp className={icon} />, hint: "7-day post curves, peak spikes and comparisons" },
      { to: "/early", label: "Early Detection", icon: <Radar className={icon} />, hint: "Stories growing before anyone alerted them" },
      { to: "/own-alerts", label: "Agent alerts", icon: <Siren className={icon} />, hint: "Alerts the agent raises from its own sources" },
      { to: "/escalations", label: "Emails & T&S", icon: <Mail className={icon} />, hint: "Social Alert emails and Trust & Safety reports" },
    ] },
    { label: "Team and knowledge", items: [
      { to: "/rosters", label: "Rosters", icon: <CalendarClock className={icon} />, hint: "Who is on shift and on call" },
      { to: "/workforce", label: "Workforce", icon: <UsersRound className={icon} />, hint: "Staffing against the alert volume" },
      { to: "/knowledge", label: "Knowledge", icon: <BookOpen className={icon} />, count: counts.learning, hint: "The documents and facts the agent uses" },
      { to: "/campaigns", label: "Campaigns & watches", icon: <Megaphone className={icon} />, hint: "Topics watched for a while" },
    ] },
  ];
  const records: NavItem[] = [
    { to: "/compare", label: "Agent, Burson and IMs compared", icon: <Scale className={icon} /> },
    { to: "/suppressed", label: "Suppressed alerts", icon: <FileClock className={icon} /> },
    { to: "/parity", label: "Our alerts vs Burson's", icon: <FileClock className={icon} /> },
    { to: "/outbox", label: "Waiting to post", icon: <FileClock className={icon} />, count: counts.outbox },
    { to: "/activity", label: "Event log", icon: <FileClock className={icon} /> },
  ];
  const setup: NavItem[] = [
    { to: "/admin", label: "People & Admin", icon: <ShieldCheck className={icon} />, hint: "Add or remove people and set Admin or User roles" },
    { to: "/settings", label: "Settings", icon: <Settings className={icon} /> },
    { to: "/routing", label: "Routing", icon: <Route className={icon} /> },
    { to: "/ai", label: "AI", icon: <BrainCircuit className={icon} /> },
    { to: "/connections", label: "Integrations", icon: <Plug className={icon} /> },
  ];
  const recordsActive = records.some((e) => location.pathname.startsWith(e.to));
  const showRecords = more || recordsActive || collapsed;
  const showSetup = setupOpen || collapsed || setup.some((e) => location.pathname.startsWith(e.to));
  const meRoleLabel = me?.role === "admin" ? "Admin" : me?.role === "viewer" ? "Viewer" : "User";

  // min-h-full, not h-full: the shell must be as tall as the page, or the sticky menu leaves the screen with it
  return (
    <div className="flex min-h-full">
      {drawer && !wide && <button type="button" aria-label="Close the menu" onClick={() => setDrawer(false)} className="fixed inset-0 z-40 bg-black/50" />}
      <aside aria-label="Menu" className={cx("scroll-thin flex h-dvh shrink-0 flex-col overflow-y-auto px-3 py-4",
        wide ? cx("sticky top-0 bg-zinc-100/70 dark:bg-zinc-900/60", collapsed ? "w-[68px]" : "w-64")
          : cx("fixed inset-y-0 left-0 z-50 w-72 bg-zinc-100 transition-transform duration-200 dark:bg-zinc-900", drawer ? "translate-x-0" : "-translate-x-full"))}>
        <div className={cx("mb-5 flex items-center gap-2", collapsed ? "justify-center" : "px-2")}>
          <Link to="/" className="flex min-w-0 items-center gap-2.5" aria-label="Dashboard">
            <Mark className="size-7 shrink-0" />
            {!collapsed && <span className="truncate text-[15px] font-medium tracking-tight text-zinc-900 dark:text-zinc-50">SLRR Triage</span>}
          </Link>
          {!collapsed && me?.env && me.env !== "prod" && <span className="rounded-full border border-zinc-300 px-2 text-xs text-zinc-500 dark:border-zinc-700">{me.env}</span>}
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
          {groups.map((group, i) => (
            <div key={group.label} className={cx("flex flex-col gap-0.5", i > 0 && "mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800")}>
              <GroupLabel collapsed={collapsed}>{group.label}</GroupLabel>
              {group.items.map((item) => <Item key={item.to} item={item} collapsed={collapsed} />)}
            </div>
          ))}
          <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            {!collapsed && (
              <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={showRecords}
                className="flex w-full items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500 hover:bg-zinc-200/70 dark:hover:bg-zinc-800">
                <span className="flex-1 text-left">Records</span><ChevronDown className={cx("size-3.5 transition-transform", showRecords && "rotate-180")} aria-hidden />
              </button>
            )}
            {showRecords && <div className="mt-0.5 flex flex-col gap-0.5">{records.map((item) => <Item key={item.to} item={item} collapsed={collapsed} />)}</div>}
          </div>
        </nav>
        <div className="mt-4 flex flex-col gap-0.5 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          {!wide && <div className="px-1 pb-2"><GmailButton /></div>}
          {(me?.is_admin || me?.is_lead) && <>
            {!collapsed && (
              <button type="button" onClick={() => setSetupOpen((o) => !o)} aria-expanded={showSetup}
                className="flex w-full items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500 hover:bg-zinc-200/70 dark:hover:bg-zinc-800">
                <span className="flex-1 text-left">Admin & setup</span><ChevronDown className={cx("size-3.5 transition-transform", showSetup && "rotate-180")} aria-hidden />
              </button>
            )}
            {showSetup && setup.map((item) => <Item key={item.to} item={item} collapsed={collapsed} />)}
          </>}
          <Item item={{ to: "/help", label: "Help", icon: <CircleHelp className={icon} /> }} collapsed={collapsed} />
          {wide && (
            <button type="button" onClick={() => setFolded((c) => !c)} title={collapsed ? "Open the menu" : "Make the menu narrow"}
              className={cx("flex items-center gap-3 rounded-full px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800", collapsed && "justify-center px-0")}>
              {collapsed ? <PanelLeftOpen className={icon} /> : <PanelLeftClose className={icon} />}{!collapsed && "Narrow menu"}
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 bg-zinc-50/85 px-4 py-3 backdrop-blur sm:px-6 dark:bg-zinc-950/85">
          {!wide && (
            <button type="button" onClick={() => setDrawer(true)} aria-label="Open the menu" aria-expanded={drawer} className="-ml-1 flex items-center gap-2 rounded-full p-2 text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-200 dark:hover:bg-zinc-800">
              <Menu className="size-5" /><Mark className="size-6" />
            </button>
          )}
          <span className="flex-1" />
          {wide && <GmailButton />}
          <AlertPopups />
          <Link to={helpPathFor(location.pathname)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800" title="Help for this page">
            <CircleHelp className="size-4" /><span className="hidden sm:inline">Help</span>
          </Link>
          <button type="button" onClick={toggleTheme} aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"}
            className="rounded-full p-2 text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          {me && (
            me.is_admin ? (
              <Link to="/admin" className="ml-1 inline-flex items-center gap-2 rounded-full border border-zinc-200 p-1 text-sm hover:bg-zinc-200/60 sm:pr-3 dark:border-zinc-800 dark:hover:bg-zinc-800/70" title={`${me.email} (${meRoleLabel}) — Manage people & roles`}>
                <span className="bg-spark flex size-6 items-center justify-center rounded-full text-xs font-medium text-white">{(me.name || me.email).slice(0, 1).toUpperCase()}</span>
                <span className="hidden max-w-40 truncate text-zinc-700 sm:inline dark:text-zinc-200">{me.name || me.email.split("@")[0]}</span>
                <span className="hidden text-xs text-zinc-500 sm:inline">{meRoleLabel}</span>
              </Link>
            ) : (
              <span className="ml-1 inline-flex items-center gap-2 rounded-full border border-zinc-200 p-1 text-sm sm:pr-3 dark:border-zinc-800" title={`${me.email} (${meRoleLabel})`}>
                <span className="bg-spark flex size-6 items-center justify-center rounded-full text-xs font-medium text-white">{(me.name || me.email).slice(0, 1).toUpperCase()}</span>
                <span className="hidden max-w-40 truncate text-zinc-700 sm:inline dark:text-zinc-200">{me.name || me.email.split("@")[0]}</span>
                <span className="hidden text-xs text-zinc-500 sm:inline">{meRoleLabel}</span>
              </span>
            )
          )}
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 pb-24 pt-2 sm:px-6">{children}</main>
      </div>
      <ChatWidget />
    </div>
  );
}

