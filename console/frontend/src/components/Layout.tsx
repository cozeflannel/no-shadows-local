import {
  Activity, CalendarClock, ChevronDown, ClipboardCheck, FolderSearch, LayoutDashboard, Mail, Moon, Settings, Sun, UserRound,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink } from "react-router";

import { useApi } from "../api/hooks";
import type { OnCallNow } from "../api/types";
import { useApp } from "../context";
import { fmtTime } from "../lib/format";
import { ONCALL_SOURCE_TONE, TONE_CLASSES } from "../lib/labels";
import { GmailButton } from "./GmailButton";
import { Badge, cx, Tooltip } from "./ui";

const PRIMARY_NAV: { to: string; label: string; icon: ReactNode }[] = [
  { to: "/", label: "Overview", icon: <LayoutDashboard className="size-4" /> },
  { to: "/review", label: "Review Queue", icon: <ClipboardCheck className="size-4" /> },
  { to: "/cases", label: "Triaged Cases", icon: <FolderSearch className="size-4" /> },
  { to: "/escalations", label: "Emails & T&S", icon: <Mail className="size-4" /> },
  { to: "/settings", label: "Config & Distros", icon: <Settings className="size-4" /> },
  { to: "/rosters", label: "On-Call Rosters", icon: <CalendarClock className="size-4" /> },
];

// Diagnostics and dev tools; the Live Test Channel writes real cases, so it stays out of the primary nav.
const ADVANCED_NAV: { to: string; label: string }[] = [
  { to: "/activity", label: "Activity Log" },
  { to: "/suppressed", label: "Suppressed" },
  { to: "/parity", label: "In-House Parity" },
  { to: "/learning", label: "Learning" },
  { to: "/outbox", label: "Outbox" },
  { to: "/test", label: "Live Test Channel" },
];

function OnCallChips() {
  const { data } = useApi<OnCallNow>("/oncall/now", undefined, 60_000);
  if (!data) return null;
  return (
    <div className="hidden items-center gap-2 lg:flex">
      {Object.entries(data.rosters).map(([name, r]) => (
        <Tooltip key={name} content={<>
          <span className="font-medium">{r.label}</span>: {r.person ? `${r.person.name} (${r.person.email})` : "nobody"} via {r.source}
          {r.until ? ` until ${fmtTime(r.until)}` : ""}{r.next?.name ? `, then ${r.next.name}` : ""}
        </>}>
          <span className={cx("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-inset", TONE_CLASSES[ONCALL_SOURCE_TONE[r.source] ?? "zinc"])}>
            <UserRound className="size-3.5" />
            <span className="font-medium">{name === "slrr_im" ? "IM" : "Burson"}:</span>
            <span className="max-w-[9rem] truncate">{r.person?.name ?? "nobody"}</span>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, theme, toggleTheme } = useApp();
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="flex min-h-full flex-col bg-zinc-50 dark:bg-[#09090b]">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white/95 px-4 py-2.5 backdrop-blur md:px-6 dark:border-zinc-800 dark:bg-[#0c0c0f]/95">
        <div className="flex items-center gap-2 pr-2">
          <span className="text-lg" aria-hidden>🤖</span>
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-tight text-zinc-950 dark:text-zinc-50">SLRR Triage Config</p>
            <p className="text-[11px] text-zinc-500">All triage & escalations happen in Google Chat</p>
          </div>
        </div>

        <nav className="flex items-center gap-1" aria-label="Main">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => cx(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100",
              )}
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <Activity className="size-3.5" />
              <span>More</span>
              <ChevronDown className="size-3" />
            </button>
            {showAdvanced && (
              <div
                className="absolute left-0 top-full z-50 mt-1 w-44 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
                onMouseLeave={() => setShowAdvanced(false)}
              >
                {ADVANCED_NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setShowAdvanced(false)}
                    className={({ isActive }) => cx(
                      "block rounded-md px-3 py-1.5 text-xs font-medium",
                      isActive ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
                    )}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <OnCallChips />
          <GmailButton />
          {me && (
            <Badge tone={me.env === "prod" ? "rose" : me.env === "shadow" ? "amber" : "zinc"} title={`config ${me.config_version}`}>{me.env}</Badge>
          )}
          {me && (
            <Tooltip content={<>{me.email}<br />Role: {me.role} ({me.role_source}){me.dev_mode ? " · local dev user" : ""}</>}>
              <span className="hidden items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-700 sm:inline-flex dark:bg-zinc-800 dark:text-zinc-300">
                <UserRound className="size-3.5" />
                <span className="max-w-[10rem] truncate">{me.name ?? me.email}</span>
                <span className="rounded bg-white px-1 font-medium text-zinc-500 dark:bg-zinc-900">{me.role}</span>
              </span>
            </Tooltip>
          )}
          <button type="button" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}
