import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, cx, Input, Select, Switch, Textarea } from "./ui";

/** A JSON Schema node as pydantic writes it (only the parts the settings use). */
export interface Schema {
  type?: string; title?: string; description?: string; enum?: unknown[]; default?: unknown; properties?: Record<string, Schema>; items?: Schema;
  additionalProperties?: boolean | Schema; anyOf?: Schema[]; allOf?: Schema[]; $ref?: string; $defs?: Record<string, Schema>;
  minimum?: number; maximum?: number; exclusiveMinimum?: number;
}
type Errors = Record<string, string>;

function resolve(node: Schema | undefined, root: Schema): Schema {
  let s = node ?? {};
  for (let i = 0; i < 8; i += 1) {
    if (s.$ref) { const name = s.$ref.split("/").pop() ?? ""; s = { ...root.$defs?.[name], ...s, $ref: undefined }; continue; }
    if (s.allOf?.length === 1) { s = { ...s.allOf[0], ...s, allOf: undefined }; continue; }
    if (s.anyOf) { const real = s.anyOf.filter((o) => o.type !== "null"); if (real.length === 1) { s = { ...real[0], ...s, anyOf: undefined }; continue; } }
    break;
  }
  return s;
}
const nullable = (node: Schema | undefined) => !!node?.anyOf?.some((o) => o.type === "null");
const WORDS: Record<string, string> = { rag: "RAG", pubsub: "Pub/Sub", bigquery: "BigQuery", id: "ID", ids: "IDs", url: "URL", sla: "SLA", im: "IM", llm: "LLM", gcp: "GCP",
  api: "API", sql: "SQL", ai: "AI", dm: "DM", arima: "ARIMA", timesfm: "TimesFM", gb: "GB", s: "(seconds)", brandwatch: "Brandwatch", firestore: "Firestore", ack: "acknowledge" };
const humanize = (key: string) => key.split("_").map((w) => WORDS[w] ?? w).join(" ").replace(/^[a-z]/, (c) => c.toUpperCase());
const label = (key: string, s: Schema) => (s.title && s.title.toLowerCase().replace(/ /g, "_") !== key ? s.title : humanize(key));

function blank(s: Schema, root: Schema): unknown {
  const r = resolve(s, root);
  if (r.default !== undefined) return structuredClone(r.default);
  if (r.type === "object" && r.properties) return Object.fromEntries(Object.entries(r.properties).map(([k, v]) => [k, blank(v, root)]));
  return r.type === "boolean" ? false : r.type === "array" ? [] : r.type === "object" ? {} : r.type === "integer" || r.type === "number" ? 0 : "";
}

function Lines({ value, onChange, disabled }: { value: unknown[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => { setText((t) => (t.split("\n").map((x) => x.trim()).filter(Boolean).join("\n") === value.join("\n") ? t : value.join("\n"))); }, [value]);
  return <Textarea rows={Math.min(8, Math.max(2, value.length + 1))} value={text} disabled={disabled} className="font-sans text-sm" placeholder="One per line"
    onChange={(e) => { setText(e.target.value); onChange(e.target.value.split("\n").map((x) => x.trim()).filter(Boolean)); }} />;
}

function Json({ value, onChange, disabled }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return <Textarea rows={6} value={text} disabled={disabled} className={cx(bad && "border-rose-500")} aria-invalid={bad}
    onChange={(e) => { setText(e.target.value); try { onChange(JSON.parse(e.target.value)); setBad(false); } catch { setBad(true); } }} />;
}

function Node({ name, schema, root, value, onChange, path, errors, disabled }: {
  name: string; schema: Schema; root: Schema; value: unknown; onChange: (v: unknown) => void; path: string; errors: Errors; disabled?: boolean;
}) {
  const s = resolve(schema, root);
  const error = errors[path];
  const head = (
    <div className="min-w-0">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label(name, s)}</p>
      {s.description && <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{s.description}</p>}
      {error && <p className="mt-0.5 text-xs text-rose-500">{error}</p>}
    </div>
  );
  if (s.type === "boolean") return <div className="flex items-start justify-between gap-6 py-3">{head}<Switch checked={!!value} onChange={onChange} disabled={disabled} label={label(name, s)} /></div>;

  let control;
  if (s.enum) {
    control = <Select value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{s.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}</Select>;
  } else if (s.type === "integer" || s.type === "number") {
    control = <Input type="number" step={s.type === "integer" ? 1 : "any"} min={s.minimum} max={s.maximum} disabled={disabled} value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? (nullable(schema) ? null : 0) : Number(e.target.value))} className="max-w-48" />;
  } else if (s.type === "string") {
    const text = String(value ?? "");
    control = text.length > 90 || text.includes("\n") ? <Textarea rows={Math.min(14, Math.max(3, text.split("\n").length + 1))} className="font-sans text-sm" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      : <Input value={text} disabled={disabled} onChange={(e) => onChange(e.target.value === "" && nullable(schema) ? null : e.target.value)} />;
  } else if (s.type === "array") {
    const item = resolve(s.items, root);
    const list = Array.isArray(value) ? value : [];
    if (item.type === "object" && item.properties) {
      control = (
        <div className="space-y-3">
          {list.map((row, i) => (
            <div key={i} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <Fields schema={item} root={root} value={row as Record<string, unknown>} onChange={(v) => onChange(list.map((x, n) => (n === i ? v : x)))} path={`${path}.${i}`} errors={errors} disabled={disabled} />
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={disabled} onClick={() => onChange(list.filter((_, n) => n !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" icon={<Plus className="size-3.5" />} disabled={disabled} onClick={() => onChange([...list, blank(item, root)])}>Add</Button>
        </div>
      );
    } else if (item.type === "string" || item.type === "integer" || item.type === "number") {
      control = <Lines value={list} disabled={disabled} onChange={(v) => onChange(item.type === "string" ? v : v.map(Number).filter((n) => !Number.isNaN(n)))} />;
    } else control = <Json value={list} onChange={onChange} disabled={disabled} />;
  } else if (s.type === "object" && s.properties) {
    control = <div className="rounded-xl border border-zinc-200 px-3 dark:border-zinc-800"><Fields schema={s} root={root} value={(value ?? {}) as Record<string, unknown>} onChange={onChange} path={path} errors={errors} disabled={disabled} /></div>;
  } else if (s.type === "object" && typeof s.additionalProperties === "object") {
    const inner = resolve(s.additionalProperties, root);
    const map = (value ?? {}) as Record<string, unknown>;
    const entries = Object.entries(map);
    const rename = (from: string, to: string) => onChange(Object.fromEntries(entries.map(([k, v]) => [k === from ? to : k, v])));
    control = (
      <div className="space-y-2">
        {entries.map(([k, v], i) => (
          <div key={i} className={cx("gap-2", inner.properties ? "rounded-xl border border-zinc-200 p-3 dark:border-zinc-800" : "flex items-center")}>
            <Input value={k} disabled={disabled} aria-label="Name" className={cx(!inner.properties && "max-w-56")} onChange={(e) => rename(k, e.target.value)} />
            {inner.properties ? <Fields schema={inner} root={root} value={v as Record<string, unknown>} onChange={(nv) => onChange({ ...map, [k]: nv })} path={`${path}.${k}`} errors={errors} disabled={disabled} />
              : <Input value={String(v ?? "")} disabled={disabled} aria-label={`Value for ${k}`} onChange={(e) => onChange({ ...map, [k]: inner.type === "number" || inner.type === "integer" ? Number(e.target.value) : e.target.value })} />}
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={disabled} aria-label={`Remove ${k}`} onClick={() => onChange(Object.fromEntries(entries.filter(([x]) => x !== k)))} />
          </div>
        ))}
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={disabled || "" in map} onClick={() => onChange({ ...map, "": blank(inner, root) })}>Add</Button>
      </div>
    );
  } else control = <Json value={value} onChange={onChange} disabled={disabled} />;

  return <div className="grid grid-cols-1 gap-2 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-6">{head}<div className="min-w-0">{control}</div></div>;
}

function Fields({ schema, root, value, onChange, path, errors, disabled }: { schema: Schema; root: Schema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; path: string; errors: Errors; disabled?: boolean }) {
  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {Object.entries(schema.properties ?? {}).map(([key, sub]) => (
        <Node key={key} name={key} schema={sub} root={root} value={value?.[key]} path={path ? `${path}.${key}` : key} errors={errors} disabled={disabled}
          onChange={(v) => onChange({ ...value, [key]: v })} />
      ))}
    </div>
  );
}

/** A form built from a settings schema: one row a setting, with its description and the right control for its type. */
export function SchemaForm({ schema, value, onChange, errors = {}, disabled }: { schema: Schema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; errors?: Errors; disabled?: boolean }) {
  return <Fields schema={resolve(schema, schema)} root={schema} value={value} onChange={onChange} path="" errors={errors} disabled={disabled} />;
}
