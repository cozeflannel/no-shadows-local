import { ChevronDown, ChevronRight, Plus, Search, Trash } from "lucide-react";
import { Fragment, useState } from "react";

import type { Json } from "../../api/types";
import { Badge, cx, Field, Input, Segmented, Select, TD, TH, Toggle, TR } from "../ui";
import { ListInput } from "./StructuredEditor";

interface Conditional { label: string; min_engagement: number; recipients: string[] }
export interface Product {
  name: string; aliases: string[]; pa: string[]; gup: string[]; conditional: Conditional[]; execs: string[];
  execs_rule: string; deprecated: boolean; redirect_to: string[]; notes: string;
}
interface Triggers {
  exposure_tags: string[]; exposure_tag_prefixes: string[]; priorities: string[]; sensitive_topics: string[]; keywords: string[];
  sundar_mention: boolean; non_us_market: boolean; owned_post: boolean; match: string;
}
export interface Group { name: string; action_code: string | null; recipients: string[]; auto_include: boolean; triggers: Triggers; is_placeholder: boolean; notes: string }
export interface Distribution { version: string; products: Product[]; groups: Group[]; fallback_product: string }

const EXECS_RULES = ["suggest", "always", "p0", "high_engagement", "p0_or_high_engagement"];
const EMPTY_TRIGGERS: Triggers = { exposure_tags: [], exposure_tag_prefixes: [], priorities: [], sensitive_topics: [], keywords: [], sundar_mention: false, non_us_market: false, owned_post: false, match: "any" };

function ProductForm({ p, set, disabled }: { p: Product; set: (patch: Partial<Product>) => void; disabled?: boolean }) {
  const setCond = (i: number, patch: Partial<Conditional>) => set({ conditional: p.conditional.map((c, n) => (n === i ? { ...c, ...patch } : c)) });
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="Distro name"><Input value={p.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label="Aliases (names as they appear in alerts)"><ListInput rows={2} value={p.aliases} disabled={disabled} onChange={(v) => set({ aliases: v })} /></Field>
      <Field label={`PA alert POCs 📦 (${p.pa.length})`}><ListInput rows={4} value={p.pa} disabled={disabled} onChange={(v) => set({ pa: v })} /></Field>
      <Field label={`gUP POCs 💬 (${p.gup.length})`}><ListInput rows={4} value={p.gup} disabled={disabled} onChange={(v) => set({ gup: v })} /></Field>
      <Field label={`Execs (${p.execs.length})`}><ListInput rows={2} value={p.execs} disabled={disabled} onChange={(v) => set({ execs: v })} /></Field>
      <Field label="When execs are added">
        <Select value={p.execs_rule} disabled={disabled} onChange={(e) => set({ execs_rule: e.target.value })}>{EXECS_RULES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
      </Field>
      <div className="md:col-span-2">
        <p className="mb-1.5 text-xs font-medium text-zinc-500">Engagement add-ons</p>
        {p.conditional.map((c, i) => (
          <div key={i} className="mb-2 grid grid-cols-12 gap-2">
            <Input className="col-span-4" value={c.label} disabled={disabled} placeholder="High-engaging posts (2K+)" onChange={(e) => setCond(i, { label: e.target.value })} aria-label="Label" />
            <Input className="col-span-2" type="number" value={c.min_engagement} disabled={disabled} onChange={(e) => setCond(i, { min_engagement: Number(e.target.value) })} aria-label="Minimum engagement" />
            <div className="col-span-5"><ListInput rows={1} value={c.recipients} disabled={disabled} onChange={(v) => setCond(i, { recipients: v })} /></div>
            <button type="button" aria-label="Remove add-on" disabled={disabled} className="col-span-1 text-zinc-400 hover:text-rose-600" onClick={() => set({ conditional: p.conditional.filter((_, n) => n !== i) })}><Trash className="mx-auto size-4" /></button>
          </div>
        ))}
        <button type="button" disabled={disabled} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          onClick={() => set({ conditional: [...p.conditional, { label: "", min_engagement: 2000, recipients: [] }] })}>+ Add engagement add-on</button>
      </div>
      <div className="flex items-center gap-6">
        <Toggle checked={p.deprecated} disabled={disabled} onChange={(v) => set({ deprecated: v })} label="Deprecated (redirect alerts)" />
      </div>
      <Field label="Redirect to (when deprecated)"><ListInput rows={1} value={p.redirect_to} disabled={disabled} onChange={(v) => set({ redirect_to: v })} /></Field>
      <Field label="Notes" className="md:col-span-2"><Input value={p.notes} disabled={disabled} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </div>
  );
}

function GroupForm({ g, set, disabled }: { g: Group; set: (patch: Partial<Group>) => void; disabled?: boolean }) {
  const t = { ...EMPTY_TRIGGERS, ...g.triggers };
  const setT = (patch: Partial<Triggers>) => set({ triggers: { ...t, ...patch } });
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="Group name"><Input value={g.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label="Emoji action code"><Input value={g.action_code ?? ""} disabled={disabled} onChange={(e) => set({ action_code: e.target.value || null })} className="font-mono" /></Field>
      <Field label={`Recipients (${g.recipients.length})`} hint="gUP recipients come from each product's gUP list."><ListInput rows={3} value={g.recipients} disabled={disabled} onChange={(v) => set({ recipients: v })} /></Field>
      <div className="flex flex-col gap-2 pt-6">
        <Toggle checked={g.auto_include} disabled={disabled} onChange={(v) => set({ auto_include: v })} label="Auto-include in 📦 drafts when triggered (else suggest)" />
        <Toggle checked={g.is_placeholder} disabled={disabled} onChange={(v) => set({ is_placeholder: v })} label="Placeholder (recipients still needed)" />
      </div>
      <Field label="Trigger: exposure tags"><ListInput rows={2} value={t.exposure_tags} disabled={disabled} onChange={(v) => setT({ exposure_tags: v })} /></Field>
      <Field label="Trigger: exposure tag prefixes"><ListInput rows={2} value={t.exposure_tag_prefixes} disabled={disabled} onChange={(v) => setT({ exposure_tag_prefixes: v })} /></Field>
      <Field label="Trigger: priorities"><ListInput rows={1} value={t.priorities} disabled={disabled} onChange={(v) => setT({ priorities: v })} /></Field>
      <Field label="Trigger: sensitive topics"><ListInput rows={1} value={t.sensitive_topics} disabled={disabled} onChange={(v) => setT({ sensitive_topics: v })} /></Field>
      <Field label="Trigger: keyword regexes" className="md:col-span-2"><ListInput rows={2} value={t.keywords} disabled={disabled} onChange={(v) => setT({ keywords: v })} className="font-mono text-xs" /></Field>
      <div className="flex flex-wrap items-center gap-4 md:col-span-2">
        <Toggle checked={t.sundar_mention} disabled={disabled} onChange={(v) => setT({ sundar_mention: v })} label="Sundar mention" />
        <Toggle checked={t.non_us_market} disabled={disabled} onChange={(v) => setT({ non_us_market: v })} label="Non-US market" />
        <Toggle checked={t.owned_post} disabled={disabled} onChange={(v) => setT({ owned_post: v })} label="Owned post" />
        <label className="flex items-center gap-2 text-sm">Match
          <Select value={t.match} disabled={disabled} onChange={(e) => setT({ match: e.target.value })} className="w-24 py-1"><option value="any">any</option><option value="all">all</option></Select>
        </label>
      </div>
      <Field label="Notes" className="md:col-span-2"><Input value={g.notes} disabled={disabled} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </div>
  );
}

export function DistributionEditor({ value, onChange, disabled }: { value: Distribution; onChange: (v: Json) => void; disabled?: boolean }) {
  const [tab, setTab] = useState<"products" | "groups">("products");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const emit = (next: Distribution) => onChange(next as unknown as Json);
  const setProduct = (i: number, patch: Partial<Product>) => emit({ ...value, products: value.products.map((p, n) => (n === i ? { ...p, ...patch } : p)) });
  const setGroup = (i: number, patch: Partial<Group>) => emit({ ...value, groups: value.groups.map((g, n) => (n === i ? { ...g, ...patch } : g)) });
  const needle = q.trim().toLowerCase();
  const products = value.products.map((p, i) => ({ p, i })).filter(({ p }) => !needle || [p.name, ...p.aliases].some((s) => s.toLowerCase().includes(needle)));

  return (
    <div>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Distribution version"><Input value={value.version} disabled={disabled} onChange={(e) => emit({ ...value, version: e.target.value })} /></Field>
        <Field label="Fallback product (no distro match)">
          <Select value={value.fallback_product} disabled={disabled} onChange={(e) => emit({ ...value, fallback_product: e.target.value })}>
            {value.products.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="flex items-end">
          <Segmented label="Table" value={tab} onChange={(v) => { setTab(v); setOpen(null); }} options={[{ value: "products", label: `Products (${value.products.length})` }, { value: "groups", label: `Groups (${value.groups.length})` }]} />
        </div>
      </div>
      {tab === "products" && (
        <div className="relative mb-3 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-zinc-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter products or aliases" className="pl-8" aria-label="Filter products" />
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[760px]">
          <thead>
            {tab === "products"
              ? <tr><th className={TH} /><th className={TH}>Product</th><th className={TH}>Aliases</th><th className={TH}>PA</th><th className={TH}>gUP</th><th className={TH}>Execs rule</th><th className={TH} /></tr>
              : <tr><th className={TH} /><th className={TH}>Group</th><th className={TH}>Code</th><th className={TH}>Recipients</th><th className={TH}>Mode</th><th className={TH} /></tr>}
          </thead>
          <tbody>
            {tab === "products" && products.map(({ p, i }) => (
              <Fragment key={i}>
                <tr className={cx(TR, "cursor-pointer")} onClick={() => setOpen(open === i ? null : i)}>
                  <td className={cx(TD, "w-8")}>{open === i ? <ChevronDown className="size-4 text-zinc-400" /> : <ChevronRight className="size-4 text-zinc-400" />}</td>
                  <td className={cx(TD, "font-medium")}>{p.name || <span className="text-zinc-400">(unnamed)</span>} {p.deprecated && <Badge tone="zinc">deprecated → {p.redirect_to.join(" / ")}</Badge>}</td>
                  <td className={cx(TD, "max-w-[18rem] truncate text-xs text-zinc-500")}>{p.aliases.join(", ") || "—"}</td>
                  <td className={cx(TD, "font-mono text-xs")}>{p.pa.length}</td>
                  <td className={cx(TD, "font-mono text-xs")}>{p.gup.length}</td>
                  <td className={cx(TD, "text-xs")}>{p.execs.length ? p.execs_rule : "—"}{p.conditional.length > 0 && <Badge tone="cyan" className="ml-1">+{p.conditional.length} add-on</Badge>}</td>
                  <td className={cx(TD, "w-10")} onClick={(e) => e.stopPropagation()}>
                    <button type="button" aria-label={`Remove ${p.name}`} disabled={disabled} className="text-zinc-400 hover:text-rose-600 disabled:opacity-30"
                      onClick={() => { emit({ ...value, products: value.products.filter((_, n) => n !== i) }); setOpen(null); }}><Trash className="size-4" /></button>
                  </td>
                </tr>
                {open === i && <tr><td colSpan={7} className="bg-zinc-50/70 p-4 dark:bg-zinc-900/40"><ProductForm p={p} set={(patch) => setProduct(i, patch)} disabled={disabled} /></td></tr>}
              </Fragment>
            ))}
            {tab === "groups" && value.groups.map((g, i) => (
              <Fragment key={i}>
                <tr className={cx(TR, "cursor-pointer")} onClick={() => setOpen(open === i ? null : i)}>
                  <td className={cx(TD, "w-8")}>{open === i ? <ChevronDown className="size-4 text-zinc-400" /> : <ChevronRight className="size-4 text-zinc-400" />}</td>
                  <td className={cx(TD, "font-medium")}>{g.name} {g.is_placeholder && <Badge tone="amber">placeholder</Badge>}</td>
                  <td className={cx(TD, "font-mono text-xs")}>{g.action_code ?? "—"}</td>
                  <td className={cx(TD, "font-mono text-xs")}>{g.recipients.length}</td>
                  <td className={TD}><Badge tone={g.auto_include ? "emerald" : "zinc"}>{g.auto_include ? "auto-include" : "suggest only"}</Badge></td>
                  <td className={cx(TD, "w-10")} onClick={(e) => e.stopPropagation()}>
                    <button type="button" aria-label={`Remove ${g.name}`} disabled={disabled} className="text-zinc-400 hover:text-rose-600 disabled:opacity-30"
                      onClick={() => { emit({ ...value, groups: value.groups.filter((_, n) => n !== i) }); setOpen(null); }}><Trash className="size-4" /></button>
                  </td>
                </tr>
                {open === i && <tr><td colSpan={6} className="bg-zinc-50/70 p-4 dark:bg-zinc-900/40"><GroupForm g={g} set={(patch) => setGroup(i, patch)} disabled={disabled} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" disabled={disabled}
        onClick={() => {
          if (tab === "products") {
            emit({ ...value, products: [...value.products, { name: "", aliases: [], pa: [], gup: [], conditional: [], execs: [], execs_rule: "suggest", deprecated: false, redirect_to: [], notes: "" }] });
            setOpen(value.products.length);
            setQ("");
          } else {
            emit({ ...value, groups: [...value.groups, { name: "", action_code: null, recipients: [], auto_include: false, triggers: { ...EMPTY_TRIGGERS }, is_placeholder: true, notes: "" }] });
            setOpen(value.groups.length);
          }
        }}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950">
        <Plus className="size-3.5" /> Add {tab === "products" ? "product" : "group"}
      </button>
    </div>
  );
}
