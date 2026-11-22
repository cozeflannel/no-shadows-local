import { ExternalLink, Search } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { apiSend, type ApiError } from "../api/client";
import { useApp } from "../context";
import { fmtDateTime } from "../lib/format";
import { Alert, Button, Input } from "./ui";

interface WebSource { n: number; title: string; site: string; url: string }
interface WebFound {
  at: string; need: string; search: "google" | "enterprise";
  parts: { text: string; sources: number[] }[]; sources: WebSource[]; queries: string[]; suggestions: string;
}

// Held while this Console tab is open and no longer. Google's terms: a searched answer is shown to the person who asked and is not stored.
const shown = new Map<string, WebFound>();

const SEARCHES = { google: "Google Search", enterprise: "Web Grounding for Enterprise" };
// A plain inline box, so a line never breaks between a sentence and its numbers.
const CITE = "ml-0.5 rounded-full bg-zinc-200 px-[5px] py-px align-[0.25em] text-[10px] font-medium leading-none text-zinc-700 no-underline hover:bg-blue-600 hover:text-white focus-visible:outline-2 focus-visible:outline-blue-500 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-blue-500";

/**
 * Google's search suggestions, drawn from the HTML and CSS Google sent with nothing changed. They sit in a frame of
 * their own so their styles stay theirs and no script in them can run; a press opens Google's results in a new tab.
 * Google's styles choose light or dark by the device's setting, not by the Console's, so on a dark Console they can be
 * light. The frame around them is told the Console's mode only so that it stays see-through.
 */
function Suggestions({ html, theme }: { html: string; theme: "light" | "dark" }) {
  const [height, setHeight] = useState(52);
  const doc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${theme}"><base target="_blank">`
    + `<style>html,body{margin:0;background:transparent}body{padding:1px}</style></head><body>${html}</body></html>`, [html, theme]);
  return (
    <iframe title="Google Search suggestions" srcDoc={doc} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      className="block w-full border-0" style={{ height, colorScheme: theme }}
      onLoad={(e) => { const d = e.currentTarget.contentDocument; if (d) setHeight(Math.max(d.documentElement.scrollHeight, d.body.scrollHeight)); }} />
  );
}

/** The On the web tab of a temp check: ask what you need to know about the issue, and read what Gemini found with Google. */
export function TempCheckWeb({ checkId, issue, canAct }: { checkId: string; issue: string; canAct: boolean }) {
  const { theme } = useApp();
  const [found, setFound] = useState<WebFound | null>(() => shown.get(checkId) ?? null);
  const [need, setNeed] = useState(() => shown.get(checkId)?.need ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const urls = new Map((found?.sources ?? []).map((s) => [s.n, s]));

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await apiSend<WebFound>("post", `/temp-checks/${checkId}/web`, { need });
      shown.set(checkId, res);
      setFound(res);
    } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <label className="min-w-64 flex-1">
          <span className="mb-1 block text-sm font-medium text-zinc-900 dark:text-zinc-100">What do you need to know about it?</span>
          <Input value={need} onChange={(e) => setNeed(e.target.value)} maxLength={500} disabled={!canAct || busy} placeholder="What people are saying about it" />
        </label>
        <Button type="submit" variant="primary" icon={<Search className="size-4" />} loading={busy} disabled={!canAct}>Search the web</Button>
      </form>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Gemini searches Google about {issue ? `"${issue}"` : "this issue"}. The answer is shown to you only, is not kept, and is in none of this temp check's numbers.
      </p>
      {error && <Alert tone="rose">{error}</Alert>}
      {found && (
        <div className="max-w-3xl space-y-3">
          {found.parts.length > 0 ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
              {found.parts.map((p, i) => (
                <span key={i}>
                  {p.text}
                  {p.sources.map((n) => urls.has(n) && <a key={n} className={CITE} href={urls.get(n)!.url} target="_blank" rel="noreferrer" title={urls.get(n)!.title}>{n}</a>)}
                </span>
              ))}
            </p>
          ) : <p className="text-sm text-zinc-600 dark:text-zinc-400">Nothing about it was found on the web.</p>}
          {found.suggestions ? <Suggestions html={found.suggestions} theme={theme} /> : found.queries.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">Searches run:</span>
              {found.queries.map((q) => (
                <a key={q} href={`https://www.google.com/search?q=${encodeURIComponent(q)}`} target="_blank" rel="noreferrer"
                  className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-700 no-underline hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">{q}</a>
              ))}
            </div>
          )}
          {found.sources.length > 0 && (
            <ol className="space-y-1 text-sm">
              {found.sources.map((s) => (
                <li key={s.n} className="flex items-baseline gap-2">
                  <span className="w-5 shrink-0 text-right tabular-nums text-zinc-500">{s.n}</span>
                  <a href={s.url} target="_blank" rel="noreferrer" className="min-w-0 text-blue-700 hover:underline dark:text-blue-300">
                    <span className="break-words">{s.title}</span> <ExternalLink className="inline size-3 align-baseline" aria-hidden />
                  </a>
                  {s.site && s.site !== s.title && <span className="shrink-0 text-xs text-zinc-500">{s.site}</span>}
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Searched {fmtDateTime(found.at)} with {SEARCHES[found.search]}, for: {found.need}</p>
        </div>
      )}
    </div>
  );
}
