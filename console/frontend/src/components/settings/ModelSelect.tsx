import { useEffect, useState, useSyncExternalStore } from "react";

import { apiGet, type ApiError } from "../../api/client";
import { Input, Select } from "../ui";

/** One model on offer, as GET /api/settings/available-models gives it. */
export interface ModelChoice { name: string; label: string; description: string; preview: boolean; in_use: string[] }
/** What one model setting picks from (kind), and the model it uses when left at its default. */
export interface ModelField { kind: "text" | "embedding" | "none"; label: string; blank: boolean; default: string; follows: string; none_label: string }
export interface ModelCatalog {
  source: "vertex" | "fallback"; project: string; location: string; fetched_at: string; error: string; technical?: string;
  text: ModelChoice[]; embedding: ModelChoice[]; fields: Record<string, ModelField>;
}
export type ModelKind = "text" | "embedding";

// One read of the list for the whole page: every model field shares it. It is read again when the settings change
// (a field's default follows another setting) and when an admin asks.
interface Shared { catalog: ModelCatalog | null; error: ApiError | null; loading: boolean; version: string }
let shared: Shared = { catalog: null, error: null, loading: false, version: "" };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const set = (next: Partial<Shared>) => { shared = { ...shared, ...next }; listeners.forEach((l) => l()); };

export function loadModels(version = "", refresh = false): void {
  if (!refresh && shared.version === version && (shared.loading || shared.catalog)) return;
  set({ loading: true, version });
  apiGet<ModelCatalog>("/settings/available-models", refresh ? { refresh: true } : undefined)
    .then((catalog) => { if (shared.version === version) set({ catalog, error: null, loading: false }); })
    .catch((err: unknown) => { if (shared.version === version) set({ error: err as ApiError, loading: false }); });
}

/** The models on offer and each model setting's default. `version` is the settings' version: a new one reads them again
 * (nothing is read until it is known). */
export function useModelCatalog(version?: string): Shared & { refresh: () => void } {
  const state = useSyncExternalStore(subscribe, () => shared);
  useEffect(() => { if (version !== undefined) loadModels(version); }, [version]);
  return { ...state, refresh: () => loadModels(version ?? "", true) };
}

/** Whether a settings field names a Gemini model, and which list it picks from: from the field's metadata when the
 * settings carry it (x-model), else from its name (a text setting whose name or title says model). */
export function modelKindOf(key: string, schema: { type?: string; enum?: unknown[]; title?: string; description?: string; "x-model"?: string }): ModelKind | null {
  const meta = schema["x-model"];
  if (meta) return meta === "text" || meta === "embedding" ? meta : null;
  if (schema.type !== "string" || schema.enum) return null;
  const words = `${key} ${schema.title ?? ""}`.toLowerCase();
  if (!/model/.test(words) || /dataset\.|arima|timesfm/.test(`${words} ${schema.description ?? ""}`.toLowerCase())) return null;
  return /embedding/.test(words) ? "embedding" : "text";
}

/** A model setting's description without its "Blank = ..." sentence: the list's first choice says what the default is. */
export const withoutBlank = (text?: string) => (text ?? "").replace(/\s*Blank\s*=\s*[^.]*\.?/i, "").trim();

const DEFAULT = "__default__";
const OTHER = "__other__";

/** A model setting as a list: the default first (naming the model it uses), then the models this Google Cloud project
 * can use, then Other to type a name. The value set now is always shown, listed or not. */
export function ModelSelect({ value, onChange, kind, field, catalog, disabled, label, unknownDefault = "the model this is set to use" }: {
  value: string; onChange: (v: string) => void; kind: ModelKind; field?: ModelField; catalog: ModelCatalog | null; disabled?: boolean;
  label?: string; unknownDefault?: string;
}) {
  const list = catalog ? catalog[kind] : [];
  const blank = field ? field.blank : true;
  const fallback = field && !field.blank ? field.default : "";
  const atDefault = value === "" || (!blank && value === fallback);
  const listed = list.some((m) => m.name === value);
  const [typing, setTyping] = useState(false);
  const picked = typing ? OTHER : atDefault ? DEFAULT : value;
  const named = field ? (field.default || field.none_label || "none") : unknownDefault;
  const choose = (next: string) => {
    if (next === OTHER) { setTyping(true); return; }
    setTyping(false);
    onChange(next === DEFAULT ? (blank ? "" : fallback) : next);
  };
  const note = atDefault
    ? field?.follows ? `The default follows the ${field.follows} setting.` : ""
    : `Model name: ${value}.`;
  const source = !catalog ? "Reading the models this project can use…"
    : catalog.source === "vertex" ? ""
      : `${catalog.error} The list shows the models already set and ones known to work; choose Other to type another name.`;
  return (
    <div className="space-y-2">
      <Select value={picked} disabled={disabled} aria-label={label} onChange={(e) => choose(e.target.value)}>
        <option value={DEFAULT}>Use the default ({named})</option>
        {!atDefault && !listed && !typing && value && <option value={value}>{value} (not in the list)</option>}
        {list.length > 0 && (
          <optgroup label={catalog?.source === "vertex" ? "Gemini models in this Google Cloud project" : "Models already set, and ones known to work"}>
            {list.map((m) => <option key={m.name} value={m.name}>{m.label} - {m.description}{m.in_use.length ? " (in use)" : ""}</option>)}
          </optgroup>
        )}
        <option value={OTHER}>Other: type a model name…</option>
      </Select>
      {typing && <Input autoFocus value={value} disabled={disabled} placeholder="The model's name, for example gemini-3.8-flash" aria-label={label ? `${label}: model name` : "Model name"}
        onChange={(e) => onChange(e.target.value.trim())} />}
      {(note || source) && <p className="text-xs text-zinc-500 dark:text-zinc-400">{[note, source].filter(Boolean).join(" ")}</p>}
    </div>
  );
}
