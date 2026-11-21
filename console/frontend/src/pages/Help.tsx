import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";

import { useApi } from "../api/hooks";
import { Card, cx, EmptyState, ErrorState, Input, PageHeader, Select, Spinner } from "../components/ui";

interface Section { heading: string; steps?: string[]; items?: string[]; text?: string }
interface Topic { id: string; page: string; title: string; audience: string; summary: string; sections: Section[] }

export default function HelpPage() {
  const { topic = "getting-started" } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<{ topics: Topic[] }>("/help");
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!needle || !data) return null;
    return data.topics.flatMap((t) => t.sections.filter((s) => [t.title, s.heading, s.text ?? "", ...(s.steps ?? []), ...(s.items ?? [])].join(" ").toLowerCase().includes(needle)).map((s) => ({ topic: t, section: s })));
  }, [needle, data]);
  const current = data?.topics.find((t) => t.id === topic) ?? data?.topics[0];
  const pages = [...new Set(data?.topics.map((t) => t.page) ?? [])];
  const renderSection = (s: Section) => (
    <section key={s.heading} className="max-w-[72ch]">
      <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.heading}</h3>
      {s.text && <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{s.text}</p>}
      {s.steps && <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{s.steps.map((x) => <li key={x}>{x}</li>)}</ol>}
      {s.items && <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{s.items.map((x) => <li key={x}>{x}</li>)}</ul>}
    </section>
  );
  return (
    <div>
      <PageHeader title="Help" actions={<div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-zinc-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help" aria-label="Search help" className="w-full pl-9 sm:w-64" /></div>} />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[15rem_1fr]">
          <Select className="lg:hidden" aria-label="Help topic" value={current?.id ?? ""} onChange={(e) => { setQ(""); navigate(`/help/${e.target.value}`); }}>
            {pages.map((page) => <optgroup key={page} label={page}>{data.topics.filter((t) => t.page === page).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</optgroup>)}
          </Select>
          <nav aria-label="Help topics" className="hidden h-fit space-y-4 lg:sticky lg:top-16 lg:block">
            {pages.map((page) => (
              <div key={page} className="space-y-0.5">
                <p className="px-3 pb-1 text-xs text-zinc-500">{page}</p>
                {data.topics.filter((t) => t.page === page).map((t) => (
                  <NavLink key={t.id} to={`/help/${t.id}`} onClick={() => setQ("")} className={() => cx("block truncate rounded-full px-3 py-1.5 text-sm",
                    !needle && t.id === current?.id ? "bg-blue-100 font-medium text-blue-800 dark:bg-blue-200/15 dark:text-blue-200" : "text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800")}>{t.title}</NavLink>
                ))}
              </div>
            ))}
          </nav>
          {hits ? (
            <Card title={`${hits.length} result${hits.length === 1 ? "" : "s"} for "${q.trim()}"`}>
              {hits.length === 0 ? <EmptyState title="Nothing found">Try a page name or a word from a setting.</EmptyState> : (
                <div className="space-y-5">{hits.map(({ topic: t, section: s }) => (
                  <div key={t.id + s.heading}><NavLink to={`/help/${t.id}`} onClick={() => setQ("")} className="text-xs font-medium text-blue-600 dark:text-blue-200">{t.title}</NavLink>{renderSection(s)}</div>))}</div>
              )}
            </Card>
          ) : current && (
            <Card title={current.title} subtitle={`${current.summary} For ${current.audience}.`}><div className="space-y-5">{current.sections.map(renderSection)}</div></Card>
          )}
        </div>
      )}
    </div>
  );
}
