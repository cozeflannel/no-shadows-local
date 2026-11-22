import { ArrowRight, Inbox, MessagesSquare, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { useApp } from "../context";

/** The landing and sign-in page: what the Console is, and the way in. Google sign-in runs in front of the app. */
export default function WelcomePage({ state = "signed-in", children }: { state?: "signed-out" | "no-access" | "signed-in"; children?: ReactNode }) {
  const { me, theme, toggleTheme } = useApp();
  const points: { icon: ReactNode; title: string; text: string }[] = [
    { icon: <Inbox className="size-5" />, title: "Every alert, triaged", text: "Classified, checked and corrected, with how many fields Burson got right." },
    { icon: <MessagesSquare className="size-5" />, title: "Chat and Console as one", text: "Work an alert in the space or here. Both land in the same case and audit log." },
    { icon: <Sparkles className="size-5" />, title: "An agent you can direct", text: "Ask it, or have it carry an alert through, with your confirmation before it acts." },
    { icon: <ShieldCheck className="size-5" />, title: "Nothing leaves unchecked", text: "Allow-lists, a leak guard and switches that start off." },
  ];
  return (
    <div className="flex min-h-full flex-col px-6">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between py-5">
        <span className="text-[15px] font-medium tracking-tight text-zinc-900 dark:text-zinc-50">SLRR Triage</span>
        <button type="button" onClick={toggleTheme} className="rounded-full px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800">{theme === "dark" ? "Light" : "Dark"} theme</button>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center pb-16">
        <h1 className="text-spark w-fit text-5xl font-medium leading-[1.1] tracking-tight sm:text-6xl">Triage Console</h1>
        <p className="mt-4 max-w-xl text-2xl leading-snug text-zinc-500 dark:text-zinc-400">See what the agent is doing in Chat, and act on any alert.</p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {state === "signed-out" && <button type="button" onClick={() => window.location.assign(window.location.pathname)} className="glow inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">Sign in with Google<ArrowRight className="size-4" /></button>}
          {state === "signed-in" && <Link to="/" className="glow inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50">Open the dashboard<ArrowRight className="size-4" /></Link>}
          {state === "signed-in" && me && <span className="text-sm text-zinc-500">Signed in as {me.email} ({me.role})</span>}
        </div>
        {children && <div className="mt-6 max-w-xl">{children}</div>}
        <ul className="mt-14 grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
          {points.map((p) => (
            <li key={p.title} className="flex gap-3">
              <span className="mt-0.5 text-zinc-500">{p.icon}</span>
              <span><span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.title}</span><span className="block max-w-sm text-sm text-zinc-500">{p.text}</span></span>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
