import { FileSpreadsheet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { apiSend, type ApiError } from "../api/client";
import { useApp } from "../context";
import { fmtNum } from "../lib/format";
import type { Tone } from "../lib/labels";
import { Alert, Badge, Button, cx, ErrorState, Modal, Segmented, Spinner, TD, TH, TR } from "./ui";

// Bringing the sheet-based chat bot's knowledge docs and signals over to the Console: a preview first, then apply.
// The backend reads the sheet with the Console's own account (POST /api/knowledge/import-sheet, /api/watches/import-sheet).

type Action = "add" | "update" | "unchanged" | "skip";
type Counts = Record<Action, number>;
interface Sheet { id: string; title: string; read_as: string }
export interface DocImportItem { action: Action; title: string; row: number | null; link: string; covers: string; external_ok: boolean; kind: string; source_type: string; chars: number; doc_id: string; reason: string; changes: string[]; copy: string }
interface DocImportResult { dry_run: boolean; sheet: Sheet; counts: Counts; items: DocImportItem[]; notes: string[]; applied: { title: string; doc_id: string; action: string; status: string }[]; remaining: number }
export interface SignalImportItem { action: Action; name: string; row: number | null; on_in_sheet: boolean; sheet_status: string; watch_id: string; enabled: boolean; reason: string; changes: string[] }
interface SignalImportResult { dry_run: boolean; sheet: Sheet; counts: Counts; items: SignalImportItem[]; notes: string[]; applied: { name: string; watch_id: string; action: string }[]; on_in_sheet: string[] }

const ACTION: Record<Action, { label: string; tone: Tone }> = {
  add: { label: "New", tone: "emerald" }, update: { label: "Update", tone: "blue" }, unchanged: { label: "Already here", tone: "zinc" }, skip: { label: "Left out", tone: "violet" },
};
const ORDER: Action[] = ["add", "update", "skip", "unchanged"];
type Filter = Action | "all";

function Summary({ counts, sheet, noun }: { counts: Counts; sheet: Sheet; noun: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        From the sheet <span className="font-medium">{sheet.title || sheet.id}</span>, read as {sheet.read_as || "the signed-in Google account"}. Nothing is written to the sheet.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {ORDER.filter((a) => counts[a] > 0).map((a) => <span key={a} className="inline-flex items-center gap-1.5"><Badge tone={ACTION[a].tone}>{ACTION[a].label}</Badge><span className="tabular-nums text-zinc-700 dark:text-zinc-300">{counts[a]} {noun}{counts[a] === 1 ? "" : "s"}</span></span>)}
        {ORDER.every((a) => counts[a] === 0) && <span className="text-zinc-500">The sheet lists no {noun}s.</span>}
      </div>
    </div>
  );
}

function FilterBar({ value, onChange, counts }: { value: Filter; onChange: (f: Filter) => void; counts: Counts }) {
  const total = ORDER.reduce((n, a) => n + counts[a], 0);
  return <Segmented<Filter> label="Show" value={value} onChange={onChange}
    options={[{ value: "all", label: `All (${total})` }, ...ORDER.filter((a) => counts[a] > 0).map((a) => ({ value: a, label: `${ACTION[a].label} (${counts[a]})` }))]} />;
}

const sortByAction = <T extends { action: Action }>(items: T[]) => [...items].sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));

/** Knowledge → "Bring over from the sheet": the sheet's Resources tab, with the text the chat bot already read. Admins. */
export function KnowledgeImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [preview, setPreview] = useState<DocImportResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply">("");
  const [progress, setProgress] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const check = useCallback(async () => {
    setBusy("preview"); setError(null); setPreview(null); setFilter("all"); setProgress("");
    try { setPreview(await apiSend<DocImportResult>("post", "/knowledge/import-sheet", { dry_run: true })); }
    catch (err) { setError(err as ApiError); } finally { setBusy(""); }
  }, []);
  useEffect(() => { if (open) void check(); }, [open, check]);
  const todo = preview ? preview.counts.add + preview.counts.update : 0;
  const apply = async () => {
    setBusy("apply"); setError(null);
    let done = 0;
    try {
      for (let round = 0; round < 40; round++) {  // big documents go a few at a time, so no single step runs too long
        setProgress(`Bringing documents over: ${done} of ${todo} done. A big one (the KOF lists) can take a minute.`);
        const step = await apiSend<DocImportResult>("post", "/knowledge/import-sheet", { dry_run: false });
        done += step.applied.length;
        if (step.remaining === 0) break;
      }
      toast(done === 1 ? "1 document brought over from the sheet" : `${done} documents brought over from the sheet`);
      setProgress(""); onDone(); onClose();
    } catch (err) { setError(err as ApiError); setProgress(done ? `${done} brought over before it stopped. Check again to see what is left.` : ""); }
    finally { setBusy(""); }
  };
  const rows = preview ? sortByAction(preview.items).filter((i) => filter === "all" || i.action === filter) : [];
  return (
    <Modal open={open} wide="xl" title={<span className="inline-flex items-center gap-2"><FileSpreadsheet className="size-5 text-emerald-600" aria-hidden />Bring the sheet's documents over</span>} onClose={() => { if (busy !== "apply") onClose(); }}
      footer={<>
        <Button onClick={onClose} disabled={busy === "apply"}>{preview && !todo ? "Close" : "Cancel"}</Button>
        {preview && <Button onClick={() => void check()} disabled={!!busy}>Check again</Button>}
        <Button variant="primary" loading={busy === "apply"} disabled={!preview || !todo || !!busy} onClick={() => void apply()}>
          {todo ? `Bring over ${todo} document${todo === 1 ? "" : "s"}` : "Nothing to bring over"}
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Each document on the sheet's Resources tab comes over with the text the chat bot already read. It keeps its Drive link: the Console reads it from
          there once its account can open the file, and uses the sheet's copy until then. Run this again any time: nothing is doubled, and nothing made in the Console is removed.
        </p>
        <ErrorState error={error} />
        {busy === "preview" && <Spinner label="Reading the sheet…" />}
        {progress && <Alert tone="blue">{progress}</Alert>}
        {preview && <>
          <Summary counts={preview.counts} sheet={preview.sheet} noun="document" />
          {preview.notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <FilterBar value={filter} onChange={setFilter} counts={preview.counts} />
          <div className="max-h-[30vh] overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full"><thead><tr><th className={TH}>Document</th><th className={TH}>What happens</th><th className={TH}>Why</th></tr></thead>
              <tbody>{rows.map((i, n) => (
                <tr key={`${i.action}-${i.row ?? "x"}-${n}`} className={TR}>
                  <td className={cx(TD, "max-w-80")}>
                    <span className="font-medium">{i.title}</span>
                    <span className="block text-xs text-zinc-500">{[i.row ? `Resources row ${i.row}` : "", i.chars ? `${fmtNum(i.chars)} characters` : ""].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td className={TD}><Badge tone={ACTION[i.action].tone}>{ACTION[i.action].label}</Badge></td>
                  <td className={cx(TD, "text-xs text-zinc-600 dark:text-zinc-300")}>{i.reason}</td>
                </tr>))}</tbody></table>
          </div>
        </>}
      </div>
    </Modal>
  );
}

/** Signals → "Bring over the sheet's signals": the sheet's Watches tab, every signal OFF. Leads. */
export function SignalImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [preview, setPreview] = useState<SignalImportResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply">("");
  const check = useCallback(async () => {
    setBusy("preview"); setError(null); setPreview(null);
    try { setPreview(await apiSend<SignalImportResult>("post", "/watches/import-sheet", { dry_run: true })); }
    catch (err) { setError(err as ApiError); } finally { setBusy(""); }
  }, []);
  useEffect(() => { if (open) void check(); }, [open, check]);
  const todo = preview ? preview.counts.add + preview.counts.update : 0;
  const apply = async () => {
    setBusy("apply"); setError(null);
    try {
      const done = await apiSend<SignalImportResult>("post", "/watches/import-sheet", { dry_run: false });
      toast(`${done.applied.length} signal${done.applied.length === 1 ? "" : "s"} brought over, all off`);
      onDone(); onClose();
    } catch (err) { setError(err as ApiError); } finally { setBusy(""); }
  };
  return (
    <Modal open={open} wide="xl" title={<span className="inline-flex items-center gap-2"><FileSpreadsheet className="size-5 text-emerald-600" aria-hidden />Bring the sheet's signals over</span>} onClose={() => { if (busy !== "apply") onClose(); }}
      footer={<>
        <Button onClick={onClose} disabled={busy === "apply"}>{preview && !todo ? "Close" : "Cancel"}</Button>
        <Button variant="primary" loading={busy === "apply"} disabled={!preview || !todo || !!busy} onClick={() => void apply()}>
          {todo ? `Bring over ${todo} signal${todo === 1 ? "" : "s"} (all off)` : "Nothing to bring over"}
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Each row of the sheet's Watches tab becomes a signal with the same question, scoring, topics, flag score and networks. Every one comes over off,
          even if it is on in the sheet: only a person turns a signal on here. A signal with the same name is updated, never doubled, and stays on or off as it is.
        </p>
        <ErrorState error={error} />
        {busy === "preview" && <Spinner label="Reading the sheet…" />}
        {preview && <>
          <Summary counts={preview.counts} sheet={preview.sheet} noun="signal" />
          {preview.on_in_sheet.length > 0 && <Alert tone="blue" title="On in the sheet today">{preview.on_in_sheet.join(", ")}. They come over off: turn them on here when you are ready.</Alert>}
          {preview.notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <div className="overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full"><thead><tr><th className={TH}>Signal</th><th className={TH}>In the sheet</th><th className={TH}>What happens</th><th className={TH}>Why</th></tr></thead>
              <tbody>{sortByAction(preview.items).map((i) => (
                <tr key={`${i.name}-${i.row}`} className={TR}>
                  <td className={TD}><span className="font-medium">{i.name}</span>{i.row && <span className="block text-xs text-zinc-500">Watches row {i.row}</span>}</td>
                  <td className={TD}><Badge tone={i.on_in_sheet ? "emerald" : "zinc"}>{i.on_in_sheet ? "On" : "Off"}</Badge>{i.sheet_status && <span className="mt-1 block max-w-56 truncate text-xs text-zinc-500" title={i.sheet_status}>{i.sheet_status}</span>}</td>
                  <td className={TD}><Badge tone={ACTION[i.action].tone}>{ACTION[i.action].label}</Badge></td>
                  <td className={cx(TD, "text-xs text-zinc-600 dark:text-zinc-300")}>{i.reason}</td>
                </tr>))}</tbody></table>
          </div>
        </>}
      </div>
    </Modal>
  );
}
