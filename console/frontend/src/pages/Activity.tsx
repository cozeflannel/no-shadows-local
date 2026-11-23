import { Pause, Play, RefreshCw, Search } from "lucide-react";
import { useState } from "react";

import { useApi } from "../api/hooks";
import type { AgentEvent } from "../api/types";
import { EventRow } from "../components/common";
import { Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner } from "../components/ui";
import { useApp } from "../context";
import { EVENT_GROUPS, eventLabel } from "../lib/labels";

export default function ActivityPage() {
  const { meta } = useApp();
  const [group, setGroup] = useState("");
  const [type, setType] = useState("");
  const [caseId, setCaseId] = useState("");
  const [escId, setEscId] = useState("");
  const [actor, setActor] = useState("");
  const [limit, setLimit] = useState(200);
  const [live, setLive] = useState(true);
  const params = { type: type || group || undefined, case_id: caseId.trim() || undefined, escalation_id: escId.trim() || undefined, actor: actor.trim() || undefined, limit };
  const { data, error, loading, reload } = useApi<{ events: AgentEvent[]; count: number }>("/activity", params, live ? 15_000 : undefined);

  return (
    <div>
      <PageHeader
        title="Activity"
        description="Everything the agent did, newest first. While live is on the list refreshes every 15 seconds."
        actions={<>
          <Button size="sm" icon={live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => setLive((l) => !l)}>{live ? "Pause live" : "Resume live"}</Button>
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>
        </>}
      />
      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Category">
            <Select value={group} onChange={(e) => { setGroup(e.target.value); setType(""); }}>
              {EVENT_GROUPS.map((g) => <option key={g.label} value={g.value}>{g.label}</option>)}
            </Select>
          </Field>
          <Field label="What happened">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Anything in the category</option>
              {(meta?.event_types ?? []).filter((t) => !group || group.split(",").some((g) => t === g || t.startsWith(g)))
                .map((t) => ({ t, label: eventLabel(t) })).sort((a, b) => a.label.localeCompare(b.label))
                .map(({ t, label }) => <option key={t} value={t}>{label}</option>)}
            </Select>
          </Field>
          <Field label="Case"><Input value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="TRG-1042" /></Field>
          <Field label="Escalation"><Input value={escId} onChange={(e) => setEscId(e.target.value)} placeholder="ESC-1207" /></Field>
          <Field label="Done by"><Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Part of a name or email" /></Field>
          <Field label="Show">
            <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[100, 200, 500, 1000].map((n) => <option key={n} value={n}>Latest {n}</option>)}
            </Select>
          </Field>
        </div>
      </Card>
      <ErrorState error={error} onRetry={reload} />
      <Card title={data ? `${data.count} events` : "Events"} subtitle="Newest first. The arrow on a row shows its details." padded={false}>
        {loading && !data ? <Spinner /> : data && data.events.length === 0 ? (
          <EmptyState icon={<Search className="size-8" />} title="No events match these filters" />
        ) : (
          <ul className="px-4">{data?.events.map((e) => <EventRow key={e.event_id} event={e} />)}</ul>
        )}
      </Card>
    </div>
  );
}
