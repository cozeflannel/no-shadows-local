import { ArrowRight, CircleCheck, CircleX, Save, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { apiSend } from "../api/client";
import { useAction, useApi } from "../api/hooks";
import { TimeCell } from "../components/common";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner, Switch, TD, TH, TR } from "../components/ui";
import { useApp } from "../context";

type SpaceKey = "source" | "mirror" | "third";
interface SpaceInfo { space: string; name: string; external: boolean; error: string }
interface Values { bot_on: boolean; source: string; mirror: string; third: string; copy_everything: boolean; ask_before_source: boolean }
interface Copy { at: string; what: string; who: string; text: string; status: string; why: string; mirror: string; third: string; third_why: string }
/** A reply the bot may not write in the closed source space, shown under the alert's copy in the second and third spaces. */
interface OwnReply { at: string; text: string; status: "waiting" | "posted" | "gave_up"; why: string; case_id: string; mirror: string; third: string }
interface Person { user: string; name: string; org: "" | "Burson" | "Google"; first_seen: string; seen_in: string; example: string }
interface ReviewRow {
  at: string; message: string; text: string; status: "reviewed" | "ignored" | "waiting" | "gave_up"; why: string; tries: number;
  case_id: string; verdict: string; summary: string; queued: number; held: { target: string; check: string }[];
}
interface Review {
  on: boolean; why: string; switch: boolean; rows: ReviewRow[];
  last_run: { ok: boolean; at: string; error: string; reviewed: number; ignored: number; failed: number } | null;
}
interface PostRow {
  id: string; at: string; target: string; to: string; text: string; status: "sent" | "held" | "waits_for_send" | "failed" | "gave_up" | "waiting";
  why: string; tries: number; case_id: string; message: string;
}
interface Delivery {
  on: boolean; why: string; switch: boolean; rows: PostRow[];
  last_run: { ok: boolean; at: string; error: string; sent: number; held: number; failed: number } | null;
}
interface Routing {
  value: Values; safety_valve: boolean; mode: { live: boolean; why: string };
  spaces: Record<SpaceKey, SpaceInfo | null>; problems: Record<SpaceKey, string>;
  signed_in: boolean; bot: string;
  last_run: { ok: boolean; at: string; error: string; copied: { mirror: number; third: number }; emojis: number } | null;
  queue: { id: string; text: string; origin: string; case_id: string; at: string }[];
  copies: Copy[]; replies: OwnReply[]; people: Person[]; review: Review; delivery: Delivery; can_edit: boolean; can_act: boolean;
}

const POSTED: Record<PostRow["status"], { label: string; tone: "emerald" | "blue" | "amber" | "rose" | "zinc" }> = {
  sent: { label: "Posted", tone: "emerald" }, held: { label: "Held", tone: "amber" }, waits_for_send: { label: "Waiting for Send", tone: "blue" },
  failed: { label: "Trying again", tone: "amber" }, gave_up: { label: "Given up", tone: "rose" }, waiting: { label: "Next minute", tone: "zinc" },
};

const SPACES: { key: SpaceKey; title: string; says: string }[] = [
  { key: "source", title: "Source space", says: "Where the messages come from: Burson's space, or any other." },
  { key: "mirror", title: "Second space", says: "Gets a copy of every message from the source, in the same order." },
  { key: "third", title: "Third space", says: "Gets a copy of everything that reached the second space." },
];
const SWITCHES: { key: "bot_on" | "safety_valve" | "copy_everything" | "ask_before_source"; title: string; says: string }[] = [
  { key: "bot_on", title: "QA chatbot", says: "ON: it reads the source space every minute and copies it. OFF: it reads and writes nothing in Chat." },
  { key: "safety_valve", title: "Safety valve", says: "ON: nothing is written in the source space, and emails go only to your test addresses. The copy spaces still get everything." },
  { key: "copy_everything", title: "Copy replies and emojis too", says: "ON: replies, people's messages and emojis are copied. OFF: only alerts are copied." },
  { key: "ask_before_source", title: "Ask before each post to the source", says: "ON: each message for the source space waits for Send or Skip. OFF: it is posted straight away." },
];
const WHAT: Record<string, string> = { alert: "Alert", reply: "Reply", message: "Message" };

function SpaceCard({ item, value, onChange, info, problem, disabled }: {
  item: (typeof SPACES)[number]; value: string; onChange: (v: string) => void; info: SpaceInfo | null; problem: string; disabled: boolean;
}) {
  return (
    <Card className="min-w-0 flex-1" title={item.title} subtitle={item.says}>
      <Field label="Space link or id" error={problem || null}>
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Paste the space's link" disabled={disabled} aria-label={`${item.title} link or id`} />
      </Field>
      {info && !info.error && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">{info.name || info.space}</span>
          <Badge tone={info.external ? "amber" : "emerald"}>{info.external ? "People outside Google can join" : "Google people only"}</Badge>
        </div>
      )}
      {!info && <p className="mt-3 text-sm text-zinc-500">{item.key === "source" ? "Not set. Nothing is read." : "Not set. No copy is made."}</p>}
    </Card>
  );
}

function PersonRow({ person, canEdit, onSaved }: { person: Person; canEdit: boolean; onSaved: () => void }) {
  const [name, setName] = useState(person.name);
  const [org, setOrg] = useState(person.org);
  const save = useAction(() => apiSend("put", "/routing/people", { user: person.user, name, org }));
  const changed = name !== person.name || org !== person.org;
  return (
    <tr className={TR}>
      <td className={cx(TD, "min-w-44")}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" disabled={!canEdit} aria-label="Name" /></td>
      <td className={cx(TD, "min-w-36")}>
        <Select value={org} onChange={(e) => setOrg(e.target.value as Person["org"])} disabled={!canEdit} aria-label="Side">
          <option value="">Not marked</option><option value="Burson">Burson</option><option value="Google">Google</option>
        </Select>
      </td>
      <td className={cx(TD, "max-w-xs truncate text-zinc-500")} title={person.example}>{person.example}</td>
      <td className={TD}>{canEdit && <Button size="sm" disabled={!changed} loading={save.loading} onClick={async () => { if (await save.run()) onSaved(); }}>Save</Button>}</td>
    </tr>
  );
}

const VERDICT_TONE: Record<string, "emerald" | "blue" | "amber" | "rose" | "zinc"> = { PASS: "emerald", CORRECTED: "blue", NEEDS_REVIEW: "amber", FAIL: "rose", SUPPRESSED: "zinc" };

/** What the QA chatbot read in the source space and what the review made of each message. */
function ReviewCard({ review }: { review: Review }) {
  const last = review.last_run;
  const ran = last ? `Last read ${new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${last.ok ? `${last.reviewed} reviewed, ${last.ignored} set aside${last.failed ? `, ${last.failed} failed` : ""}` : last.error}` : "";
  return (
    <Card className="mb-4" padded={false} title="Reviewed" subtitle="Each new message the QA chatbot read in the source space, and what the review made of it. What the review wants posted is queued.">
      {!review.on && (
        <p className="px-5 pb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Not running: {review.why}.{!review.switch && <> An admin can turn it on under <Link className="font-medium text-blue-700 hover:underline dark:text-blue-300" to="/settings/flags">Settings, Switches</Link>.</>}
        </p>
      )}
      {review.on && ran && <p className={cx("px-5 pb-3 text-xs", last?.ok ? "text-zinc-500" : "text-rose-600 dark:text-rose-400")}>{ran}</p>}
      {review.rows.length === 0 ? (review.on && <EmptyState title="Nothing read yet">New messages in the source space show here within a minute.</EmptyState>) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr><th className={TH}>When</th><th className={TH}>Message</th><th className={TH}>Result</th><th className={TH}>Case</th><th className={TH}>Queued to post</th></tr></thead>
            <tbody>
              {review.rows.map((r) => (
                <tr key={r.message} className={TR}>
                  <td className={TD}><TimeCell value={r.at} /></td>
                  <td className={cx(TD, "max-w-xl")}>
                    <span className="line-clamp-2 whitespace-pre-wrap">{r.text}</span>
                    {r.status === "gave_up" && <span className="mt-1 block text-rose-600 dark:text-rose-400">Given up after {r.tries} tries: {r.why}</span>}
                    {r.status === "waiting" && <span className="mt-1 block text-amber-600 dark:text-amber-400">Trying again: {r.why}</span>}
                  </td>
                  <td className={TD}>
                    {r.status === "reviewed" ? <Badge tone={VERDICT_TONE[r.verdict] ?? "zinc"}>{r.verdict.replace(/_/g, " ").toLowerCase() || "reviewed"}</Badge>
                      : r.status === "ignored" ? <span className="text-zinc-500">{r.summary || "set aside"}</span> : null}
                  </td>
                  <td className={TD}>{r.case_id ? <Link className="text-blue-700 hover:underline dark:text-blue-300" to={`/feed/${r.case_id}`}>{r.case_id}</Link> : ""}</td>
                  <td className={TD}>
                    {r.queued > 0 && <span>{r.queued}</span>}
                    {r.held.length > 0 && <span className="block text-xs text-amber-600 dark:text-amber-400">held: {r.held.map((h) => `${h.target} (${h.check.replace(/_/g, " ")})`).join(", ")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** What the QA chatbot posted from the queue through its Chat sign-in, held, or could not post. */
function DeliveryCard({ delivery, canAct, onChanged }: { delivery: Delivery; canAct: boolean; onChanged: () => void }) {
  const { toast } = useApp();
  const again = useAction((id: string) => apiSend("post", `/routing/delivery/${id}/retry`));
  const last = delivery.last_run;
  const ran = last ? `Last pass ${new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${last.ok ? `${last.sent} posted, ${last.held} held${last.failed ? `, ${last.failed} failed` : ""}` : last.error}` : "";
  return (
    <Card className="mb-4" padded={false} title="Posted" subtitle="Each queued message the QA chatbot posted in Chat, held, or could not post.">
      {again.error && <Alert tone="rose" className="mx-5 mb-3">{again.error.message}</Alert>}
      {!delivery.on && (
        <p className="px-5 pb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Not running: {delivery.why}.{!delivery.switch && <> Queued messages wait for a Chat flow. An admin can turn it on under <Link className="font-medium text-blue-700 hover:underline dark:text-blue-300" to="/settings/flags">Settings, Switches</Link>.</>}
        </p>
      )}
      {delivery.on && ran && <p className={cx("px-5 pb-3 text-xs", last?.ok ? "text-zinc-500" : "text-rose-600 dark:text-rose-400")}>{ran}</p>}
      {delivery.rows.length === 0 ? (delivery.on && <EmptyState title="Nothing posted yet">A queued message shows here within a minute.</EmptyState>) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr><th className={TH}>Queued</th><th className={TH}>To</th><th className={TH}>Message</th><th className={TH}>Result</th><th className={TH}>Case</th></tr></thead>
            <tbody>
              {delivery.rows.map((r) => (
                <tr key={r.id} className={TR}>
                  <td className={TD}><TimeCell value={r.at} /></td>
                  <td className={TD}>{r.to || r.target}</td>
                  <td className={cx(TD, "max-w-xl")}>
                    <span className="line-clamp-2 whitespace-pre-wrap">{r.text}</span>
                    {r.why && <span className={cx("mt-1 block", r.status === "gave_up" ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400")}>{r.why}</span>}
                  </td>
                  <td className={TD}>
                    <Badge tone={POSTED[r.status].tone}>{POSTED[r.status].label}</Badge>
                    {canAct && r.status === "gave_up" && (
                      <Button size="sm" className="mt-2 block" loading={again.loading}
                        onClick={async () => { if (await again.run(r.id)) { toast("It is posted on the next minute's pass", "success"); onChanged(); } }}>Try again</Button>
                    )}
                  </td>
                  <td className={TD}>{r.case_id ? <Link className="text-blue-700 hover:underline dark:text-blue-300" to={`/feed/${r.case_id}`}>{r.case_id}</Link> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function RoutingPage() {
  const { toast } = useApp();
  const { data, error, loading, reload } = useApi<Routing>("/routing", undefined, 30_000);
  const [form, setForm] = useState<(Values & { safety_valve: boolean }) | null>(null);
  useEffect(() => { if (data && !form) setForm({ ...data.value, safety_valve: data.safety_valve }); }, [data, form]);
  const save = useAction((body: Values & { safety_valve: boolean }) => apiSend<Routing>("put", "/routing", { value: body }));
  const decide = useAction((id: string, action: "send" | "skip") => apiSend<{ status: string }>("post", `/routing/queue/${id}`, { action }));

  if (loading && !data) return <Spinner />;
  if (!data || !form) return <ErrorState error={error} onRetry={reload} />;
  const canEdit = data.can_edit;
  const dirty = JSON.stringify(form) !== JSON.stringify({ ...data.value, safety_valve: data.safety_valve });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm({ ...form, [key]: value });
  const onSave = async () => {
    const saved = await save.run(form);
    if (saved) { setForm({ ...saved.value, safety_valve: saved.safety_valve }); toast("Routing saved", "success"); reload(); }
  };

  return (
    <div>
      <PageHeader title="Routing" description="Which Chat space the QA chatbot reads, where it copies it, and whether it may write back."
        actions={canEdit && <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty} loading={save.loading} onClick={onSave}>Save</Button>} />
      <ErrorState error={save.error ?? decide.error ?? error} />
      {!data.signed_in && (
        <Alert tone="amber" className="mb-4" title="The QA chatbot is not signed in to Chat">
          Nothing is read or copied until it is. <Link className="font-medium underline" to="/connections/chat">Sign it in under Integrations, Google Chat</Link>.
        </Alert>
      )}
      <Alert tone={data.mode.live ? "rose" : "emerald"} className="mb-4"
        title={data.mode.live ? "Open: the QA chatbot reads and writes in the source space" : "Nothing is written in the source space"}>
        {data.mode.live ? (data.value.ask_before_source ? "Each message waits below for Send or Skip." : "Its posts and emojis go straight in.") : `Why: ${data.mode.why}.`}
      </Alert>

      <div className="mb-4 flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
        {SPACES.map((item, i) => (
          <div key={item.key} className="flex min-w-0 flex-1 flex-col items-stretch gap-3 lg:flex-row lg:items-center">
            {i > 0 && <ArrowRight aria-hidden className="mx-auto size-5 shrink-0 rotate-90 text-zinc-400 lg:rotate-0" />}
            <SpaceCard item={item} value={form[item.key]} onChange={(v) => set(item.key, v)} info={data.spaces[item.key]}
              problem={data.problems[item.key]} disabled={!canEdit} />
          </div>
        ))}
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Switches">
          <ul className="flex flex-col gap-4">
            {SWITCHES.map((sw) => (
              <li key={sw.key} className="flex items-start gap-3">
                <div className="pt-0.5"><Switch checked={form[sw.key]} onChange={(v) => set(sw.key, v)} disabled={!canEdit} label={sw.title} /></div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{sw.title} <span className="font-normal text-zinc-500">is {form[sw.key] ? "ON" : "OFF"}</span></p>
                  <p className="text-sm text-zinc-500">{sw.says}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="When the QA chatbot writes in the source space">
          <ul className="flex flex-col gap-3 text-sm text-zinc-700 dark:text-zinc-300">
            <li><span className="font-medium">Safety valve ON.</span> Never. The second and third spaces still get every message.</li>
            <li><span className="font-medium">Safety valve OFF, a second space set.</span> Never. Its work goes to the copy spaces.</li>
            <li><span className="font-medium">Safety valve OFF, no second space.</span> Fully open. It reads and writes in the source space.</li>
            <li>A space people outside Google can join is never written, unless it is the source and the source is open.</li>
          </ul>
          {data.last_run && (
            <p className="mt-4 text-sm text-zinc-500">
              Last copy <TimeCell value={data.last_run.at} />: {data.last_run.error ? <span className="text-rose-600 dark:text-rose-400">{data.last_run.error}</span>
                : `${data.last_run.copied.mirror} to the second space, ${data.last_run.copied.third} to the third, ${data.last_run.emojis} emojis`}
            </p>
          )}
        </Card>
      </div>

      {(data.queue.length > 0 || data.value.ask_before_source) && (
        <Card className="mb-4" title="Waiting for Send" subtitle="Messages for the source space. Nothing is posted until someone presses Send.">
          {data.queue.length === 0 ? <p className="text-sm text-zinc-500">Nothing is waiting.</p> : (
            <ul className="flex flex-col gap-3">
              {data.queue.map((q) => (
                <li key={q.id} className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 sm:flex-row sm:items-start dark:border-zinc-800">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{q.text}</p>
                  {data.can_act && (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} loading={decide.loading}
                        onClick={async () => { if (await decide.run(q.id, "send")) { toast("Sent to the source space", "success"); reload(); } }}>Send</Button>
                      <Button size="sm" onClick={async () => { if (await decide.run(q.id, "skip")) reload(); }}>Skip</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <ReviewCard review={data.review} />
      <DeliveryCard delivery={data.delivery} canAct={data.can_act} onChanged={reload} />

      {data.replies.length > 0 && (
        <Card className="mb-4" padded={false} title="The bot's replies to the source space" subtitle="The source space is closed, so each reply is shown under its alert's copy in the second space. Nothing here was written in the source space.">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr><th className={TH}>When</th><th className={TH}>Reply</th><th className={TH}>Second</th><th className={TH}>Third</th></tr></thead>
              <tbody>
                {data.replies.map((r) => (
                  <tr key={r.at + r.text} className={TR}>
                    <td className={TD}><TimeCell value={r.at} /></td>
                    <td className={cx(TD, "max-w-xl")}>
                      <span className="line-clamp-2 whitespace-pre-wrap">{r.text}</span>
                      {r.status === "gave_up" && <span className="mt-1 block text-rose-600 dark:text-rose-400">Given up: {r.why}</span>}
                      {r.status === "waiting" && <span className="mt-1 block text-amber-600 dark:text-amber-400">{r.why ? `Trying again: ${r.why}` : "Waiting for its alert to be copied"}</span>}
                    </td>
                    <td className={TD}>{r.mirror ? <CircleCheck aria-label="Posted" className="size-4 text-emerald-600" /> : <CircleX aria-label="Not posted" className="size-4 text-zinc-400" />}</td>
                    <td className={TD}>{r.third ? <CircleCheck aria-label="Posted" className="size-4 text-emerald-600" /> : <CircleX aria-label="Not posted" className="size-4 text-zinc-400" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="mb-4" padded={false} title="Copied" subtitle="The last 100 messages taken from the source space.">
        {data.copies.length === 0 ? <EmptyState title="Nothing copied yet">Messages show here once the QA chatbot is ON and a second space is set.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr><th className={TH}>When</th><th className={TH}>What</th><th className={TH}>Message</th><th className={TH}>Second</th><th className={TH}>Third</th></tr></thead>
              <tbody>
                {data.copies.map((c) => (
                  <tr key={c.at + c.text} className={TR}>
                    <td className={TD}><TimeCell value={c.at} /></td>
                    <td className={TD}>{WHAT[c.what] ?? c.what}</td>
                    <td className={cx(TD, "max-w-xl")}>
                      <span className="line-clamp-2 whitespace-pre-wrap">{c.text}</span>
                      {c.status === "gave_up" && <span className="mt-1 block text-rose-600 dark:text-rose-400">Given up: {c.why}</span>}
                      {c.status === "waiting" && <span className="mt-1 block text-amber-600 dark:text-amber-400">Trying again: {c.why}</span>}
                    </td>
                    <td className={TD}>{c.mirror ? <CircleCheck aria-label="Copied" className="size-4 text-emerald-600" /> : <CircleX aria-label="Not copied" className="size-4 text-zinc-400" />}</td>
                    <td className={TD}>{c.third ? <CircleCheck aria-label="Copied" className="size-4 text-emerald-600" />
                      : <span title={c.third_why}><CircleX aria-label="Not copied" className="size-4 text-zinc-400" /></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data.people.length > 0 && (
        <Card padded={false} title="People seen in the source space"
          subtitle="Chat gives the QA chatbot no names. Type each person's name once and mark their side: their copied messages then read Name (Burson) or Name (Google).">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr><th className={TH}>Name</th><th className={TH}>Side</th><th className={TH}>First message seen</th><th className={TH} /></tr></thead>
              <tbody>{data.people.map((p) => <PersonRow key={p.user} person={p} canEdit={canEdit} onSaved={() => { toast("Saved", "success"); reload(); }} />)}</tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
