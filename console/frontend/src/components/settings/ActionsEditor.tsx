import { ArrowDown, ArrowUp, Plus, Trash } from "lucide-react";

import type { Json } from "../../api/types";
import { cx, Input, Select, TD, TH } from "../ui";
import { ListInput } from "./StructuredEditor";

export interface ActionRow { emoji: string; code: string; label: string; kind: string; group?: string | null; target?: string | null; recipients: string[] }

const KINDS = ["ack", "email_pa", "tns", "add_group", "post_space", "dm", "close", "superseded", "feedback", "none"];
const TARGETS = ["crisis", "team", "youtube", "doodle", "clean"];
const SM = "px-2 py-1.5 text-xs";

/** Emoji legend editor: what the agent does when an IM reacts on a clean-space alert. */
export function ActionsEditor({ value, onChange, groups, disabled }: {
  value: ActionRow[]; onChange: (v: Json) => void; groups: { name: string; action_code: string | null }[]; disabled?: boolean;
}) {
  const rows = value ?? [];
  const emit = (next: ActionRow[]) => onChange(next as unknown as Json);
  const set = (i: number, patch: Partial<ActionRow>) => emit(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows];
    const [row] = next.splice(i, 1);
    next.splice(i + d, 0, row);
    emit(next);
  };
  return (
    <div>
      <div className="scroll-thin overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[960px]">
          <thead>
            <tr><th className={TH}>Emoji</th><th className={TH}>Code</th><th className={TH}>Legend label</th><th className={TH}>Agent action</th><th className={TH}>Group / target / recipients</th><th className={TH} /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <td className={cx(TD, "w-20")}><Input className={cx(SM, "text-center text-base")} value={r.emoji} disabled={disabled} onChange={(e) => set(i, { emoji: e.target.value })} aria-label="Emoji" /></td>
                <td className={cx(TD, "w-40")}><Input className={cx(SM, "font-mono")} value={r.code} disabled={disabled} onChange={(e) => set(i, { code: e.target.value })} aria-label="Code" /></td>
                <td className={TD}><Input className={SM} value={r.label} disabled={disabled} onChange={(e) => set(i, { label: e.target.value })} aria-label="Label" /></td>
                <td className={cx(TD, "w-36")}>
                  <Select className={SM} value={r.kind} disabled={disabled} onChange={(e) => set(i, { kind: e.target.value })} aria-label="Kind">
                    {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </Select>
                </td>
                <td className={cx(TD, "w-64")}>
                  {r.kind === "add_group" ? (
                    <Select className={SM} value={r.group ?? ""} disabled={disabled} onChange={(e) => set(i, { group: e.target.value || null })} aria-label="Group">
                      <option value="">Choose a group…</option>
                      {groups.map((g) => <option key={g.name} value={g.action_code ?? g.name}>{g.name}</option>)}
                    </Select>
                  ) : r.kind === "post_space" ? (
                    <Select className={SM} value={r.target ?? ""} disabled={disabled} onChange={(e) => set(i, { target: e.target.value || null })} aria-label="Target">
                      <option value="">Choose a space…</option>
                      {TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  ) : r.kind === "dm" ? (
                    <ListInput rows={1} className={cx(SM, "font-sans")} value={r.recipients} disabled={disabled} placeholder="emails, comma-separated"
                      onChange={(list) => set(i, { recipients: list })} />
                  ) : <span className="text-xs text-zinc-400">—</span>}
                </td>
                <td className={cx(TD, "w-28 whitespace-nowrap text-right")}>
                  <button type="button" aria-label="Move up" disabled={disabled || i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-zinc-400 hover:text-zinc-700 disabled:opacity-30"><ArrowUp className="size-4" /></button>
                  <button type="button" aria-label="Move down" disabled={disabled || i === rows.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-zinc-400 hover:text-zinc-700 disabled:opacity-30"><ArrowDown className="size-4" /></button>
                  <button type="button" aria-label="Remove" disabled={disabled} onClick={() => emit(rows.filter((_, n) => n !== i))} className="rounded p-1 text-zinc-400 hover:text-rose-600 disabled:opacity-30"><Trash className="size-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" disabled={disabled} onClick={() => emit([...rows, { emoji: "", code: "", label: "", kind: "none", recipients: [] }])}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950">
        <Plus className="size-3.5" /> Add emoji
      </button>
      <p className="mt-2 text-xs text-zinc-500">Order is the legend order used for suggestions on the clean post. add_group must point at a distribution group (action code).</p>
    </div>
  );
}
