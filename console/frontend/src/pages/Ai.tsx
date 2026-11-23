import { ArrowRight, CircleCheck, CircleX, Hourglass } from "lucide-react";
import { Link } from "react-router";

import { apiSend } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { TimeCell } from "../components/common";
import { Badge, Button, Card, cx, ErrorState, PageHeader, Spinner } from "../components/ui";
import { useApp } from "../context";

/** One line of a check. `waiting`: a table whose owners have not let the Console read it yet. It does not fail the check. */
interface Step { step: string; ok: boolean; detail: string; ms: number; waiting?: boolean }
interface Check { ok: boolean; steps: Step[]; at: string; by: string }
interface Engine {
  key: "gemini" | "decisions" | "bigquery" | "documents"; name: string; role: string; does: string;
  state: "ready" | "not_connected" | "incomplete" | "failing";
  facts: { label: string; value: string }[]; switches: { name: string; title: string; on: boolean }[];
  settings: { label: string; to: string }[]; check: Check | null;
}

const STATE: Record<Engine["state"], { label: string; tone: "emerald" | "zinc" | "amber" | "rose" }> = {
  ready: { label: "Ready", tone: "emerald" }, not_connected: { label: "Not connected", tone: "zinc" },
  incomplete: { label: "Needs values", tone: "amber" }, failing: { label: "Failing", tone: "rose" },
};
/** How one early story moves through the engines, left to right. */
const PATH: { engine: string; does: string }[] = [
  { engine: "Vertex AI in BigQuery", does: "reads new posts and groups like ones into a story" },
  { engine: "Gemini Decisions", does: "scores the story and holds back noise" },
  { engine: "Document search", does: "finds what your documents say about it" },
  { engine: "Gemini", does: "writes the headline and the call a person reads" },
];

function EngineCard({ engine, canCheck, onChecked }: { engine: Engine; canCheck: boolean; onChecked: () => void }) {
  const check = useAction(() => apiSend<Check>("post", `/ai/${engine.key}/check`));
  const last = engine.check;
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-500">{engine.role}</p>
          <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">{engine.name}</h2>
        </div>
        <Badge tone={STATE[engine.state].tone}>{STATE[engine.state].label}</Badge>
      </div>
      <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{engine.does}</p>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {engine.facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-xs text-zinc-500">{f.label}</dt>
            <dd className="truncate text-sm text-zinc-900 dark:text-zinc-100" title={f.value}>{f.value}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-4 flex flex-col gap-1.5">
        {engine.switches.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-3 text-sm">
            <Link to="/settings/flags" className="text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300">{s.title}</Link>
            <Badge tone={s.on ? "emerald" : "zinc"}>{s.on ? "ON" : "OFF"}</Badge>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        {canCheck && <Button variant="primary" size="sm" loading={check.loading} onClick={async () => { if (await check.run()) onChecked(); }}>Check now</Button>}
        {engine.settings.map((s) => <Link key={s.to} to={s.to} className="text-sm font-medium text-blue-700 dark:text-blue-400">{s.label}</Link>)}
      </div>
      <ErrorState error={check.error} />
      {last && (
        <div className="mt-4">
          <p className="text-xs text-zinc-500">Checked <TimeCell value={last.at} /></p>
          <ul className="mt-2 flex flex-col gap-2">
            {last.steps.map((s) => (
              <li key={s.step} className="flex gap-2 text-sm">
                {s.ok ? <CircleCheck aria-label="Passed" className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  : s.waiting ? <Hourglass aria-label="Waiting for access" className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  : <CircleX aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-rose-600" />}
                <span className="min-w-0">
                  <span className="text-zinc-900 dark:text-zinc-100">{s.step}</span>
                  <span className={cx("block break-words", s.ok ? "text-zinc-500" : s.waiting ? "text-amber-800 dark:text-amber-300" : "text-rose-600 dark:text-rose-400")}>
                    {s.waiting ? "Waiting for access: skipped until its owners let the Console read it." : s.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export default function AiPage() {
  const { toast } = useApp();
  const { data, error, loading, reload } = useApi<{ engines: Engine[]; can_check: boolean }>("/ai", undefined, 60_000);
  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div>
      <PageHeader title="AI" description="Three engines with one job each, and the documents that ground them." />
      <Card className="mb-4" title="How an early story is made">
        <ol className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
          {PATH.map((p, i) => (
            <li key={p.engine} className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:items-center">
              {i > 0 && <ArrowRight aria-hidden className="mx-auto size-5 shrink-0 rotate-90 text-zinc-400 lg:rotate-0" />}
              <div className="min-w-0 flex-1 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.engine}</p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">{p.does}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        {data.engines.map((e) => <EngineCard key={e.key} engine={e} canCheck={data.can_check} onChecked={() => { toast("Checked", "success"); reload(); }} />)}
      </div>
    </div>
  );
}
