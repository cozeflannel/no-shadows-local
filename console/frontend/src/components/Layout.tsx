import {
  BookOpen, CalendarClock, ChevronDown, CircleHelp, FolderSearch, Gauge, Inbox, LayoutDashboard, Mail, Megaphone, Menu, MessagesSquare, Moon,
  PanelLeftClose, PanelLeftOpen, Plug, Scale, Settings, ShieldCheck, Sparkles, Sun, Thermometer, UsersRound, Waypoints,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { useApp } from "../context";
import { AlertPopups } from "./AlertPopups";
import { GmailButton } from "./GmailButton";
import { cx } from "./ui";

interface NavItem { to: string; label: string; icon: ReactNode; count?: number }

/** The Help topic that goes with each page (the first path segment). */
const HELP_TOPIC: Record<string, string> = {
  "": "dashboard", feed: "review-feed", chat: "chat-spaces", agent: "chat-agent", "temp-check": "temp-check", workforce: "workforce",
  rosters: "rosters", knowledge: "knowledge", campaigns: "campaigns", cases: "cases", escalations: "cases", settings: "settings",
  suppressed: "cases", parity: "cases", learning: "knowledge", outbox: "delivery", activity: "audit", help: "getting-started",
  stories: "stories", compare: "compare", connections: "integrations", admin: "admin",
};

export function helpPathFor(pathname: string): string {
  const [first, second] = pathname.split("/").filter(Boolean);
  if (first === "settings" && second) {
    const byPart: Record<string, string> = { flags: "feature-flags", secrets: "secrets", bigquery: "bigquery", pubsub: "delivery", prompts: "ai-behavior",
      safety: "safety", audit: "audit", costs: "costs", gcp: "deploy" };
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
    <NavLink to={item.to} end={item.to === "/"} title={collapsed ? item.label : undefined}
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

export function Layout({ children }: { children: ReactNode }) {
  const { me, counts, theme, toggleTheme } = useApp();
  const location = useLocation();
  const wide = useWide();
  const [folded, setFolded] = useState(() => {
    try { return localStorage.getItem("console-nav") === "collapsed"; } catch { return false; }
  });
  const [drawer, setDrawer] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    try { localStorage.setItem("console-nav", folded ? "collapsed" : "open"); } catch { /* private mode */ }
  }, [folded]);
  useEffect(() => { setDrawer(false); }, [location.pathname, location.search]);
  const collapsed = folded && wide; // the drawer always shows labels

  const icon = "size-[18px]";
  const groups: NavItem[][] = [
    [
      { to: "/", label: "Dashboard", icon: <LayoutDashboard className={icon} /> },
      { to: "/feed", label: "Review feed", icon: <Inbox className={icon} />, count: counts.review },
      { to: "/stories", label: "Stories", icon: <Waypoints className={icon} /> },
      { to: "/chat", label: "Chat spaces", icon: <MessagesSquare className={icon} /> },
      { to: "/agent", label: "Chat agent", icon: <Sparkles className={icon} /> },
    ],
    [
      { to: "/temp-check", label: "Temp check", icon: <Thermometer className={icon} /> },
      { to: "/workforce", label: "Workforce", icon: <UsersRound className={icon} /> },
      { to: "/campaigns", label: "Campaigns & watches", icon: <Megaphone className={icon} /> },
      { to: "/knowledge", label: "Knowledge", icon: <BookOpen className={icon} />, count: counts.learning },
    ],
    [
      { to: "/cases", label: "Cases", icon: <FolderSearch className={icon} /> },
      { to: "/escalations", label: "Emails & T&S", icon: <Mail className={icon} /> },
      { to: "/rosters", label: "Rosters", icon: <CalendarClock className={icon} /> },
      { to: "/compare", label: "Compare", icon: <Scale className={icon} /> },
    ],
  ];
  const extra: NavItem[] = [
    { to: "/suppressed", label: "Suppressed", icon: <Gauge className={icon} /> },
    { to: "/parity", label: "Our alerts vs Burson's", icon: <Gauge className={icon} /> },
    { to: "/outbox", label: "Waiting to post", icon: <Gauge className={icon} />, count: counts.outbox },
    { to: "/activity", label: "Event log", icon: <Gauge className={icon} /> },
  ];
  const extraActive = extra.some((e) => location.pathname.startsWith(e.to));

  return (
    <div className="flex h-full">
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
            <div key={i} className={cx("flex flex-col gap-0.5", i > 0 && "mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800")}>
              {group.map((item) => <Item key={item.to} item={item} collapsed={collapsed} />)}
            </div>
          ))}
          {!collapsed && (
            <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more || extraActive}
                className="flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800">
                <ChevronDown className={cx(icon, "transition-transform", (more || extraActive) && "rotate-180")} />More
              </button>
              {(more || extraActive) && <div className="mt-0.5 flex flex-col gap-0.5">{extra.map((item) => <Item key={item.to} item={{ ...item, icon: <span className="size-[18px]" /> }} collapsed={false} />)}</div>}
            </div>
          )}
        </nav>
        <div className="mt-4 flex flex-col gap-0.5">
          {!wide && <div className="px-1 pb-2"><GmailButton /></div>}
          <Item item={{ to: "/help", label: "Help", icon: <CircleHelp className={icon} /> }} collapsed={collapsed} />
          {(me?.is_admin || me?.is_lead) && <>
            <Item item={{ to: "/connections", label: "Integrations", icon: <Plug className={icon} /> }} collapsed={collapsed} />
            <Item item={{ to: "/admin", label: "Admin", icon: <ShieldCheck className={icon} /> }} collapsed={collapsed} />
            <Item item={{ to: "/settings", label: "Settings", icon: <Settings className={icon} /> }} collapsed={collapsed} />
          </>}
          {wide && (
            <button type="button" onClick={() => setFolded((c) => !c)} title={collapsed ? "Open the menu" : "Collapse the menu"}
              className={cx("flex items-center gap-3 rounded-full px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800", collapsed && "justify-center px-0")}>
              {collapsed ? <PanelLeftOpen className={icon} /> : <PanelLeftClose className={icon} />}{!collapsed && "Collapse"}
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
          <Link to={helpPathFor(location.pathname)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800">
            <CircleHelp className="size-4" />Help
          </Link>
          <button type="button" onClick={toggleTheme} aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"}
            className="rounded-full p-2 text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          {me && (
            <span className="ml-1 inline-flex items-center gap-2 rounded-full border border-zinc-200 p-1 text-sm sm:pr-3 dark:border-zinc-800" title={`${me.email} (${me.role})`}>
              <span className="bg-spark flex size-6 items-center justify-center rounded-full text-xs font-medium text-white">{(me.name || me.email).slice(0, 1).toUpperCase()}</span>
              <span className="hidden max-w-40 truncate text-zinc-700 sm:inline dark:text-zinc-200">{me.name || me.email.split("@")[0]}</span>
              <span className="hidden text-xs text-zinc-500 sm:inline">{me.role}</span>
            </span>
          )}
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 pb-12 pt-2 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

