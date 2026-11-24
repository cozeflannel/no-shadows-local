import { Bold, ExternalLink, Italic, Link2, List, ListOrdered, Redo2, RemoveFormatting, RotateCcw, Save, Send, Underline, Undo2, Unlink } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { apiSend, type ApiError } from "../../api/client";
import { useApp } from "../../context";
import { fmtDateTime } from "../../lib/format";
import { GmailButton } from "../GmailButton";
import { Alert, Badge, Button, cx } from "../ui";
import type { EmailDraft } from "./types";

const STATUS: Record<EmailDraft["status"], { label: string; tone: "zinc" | "blue" | "emerald" | "rose" | "violet" }> = {
  new: { label: "Not saved yet", tone: "zinc" }, drafted: { label: "Draft in Gmail", tone: "blue" }, redrafted: { label: "Draft in Gmail", tone: "blue" },
  revision_requested: { label: "Edit asked for", tone: "violet" }, sent: { label: "Sent", tone: "emerald" }, discarded: { label: "Draft deleted in Gmail", tone: "zinc" },
  failed: { label: "Draft not written", tone: "rose" },
};
const split = (text: string) => text.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

function Tool({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-lg text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-700">
      {children}
    </button>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-baseline gap-3 border-b border-zinc-200 px-4 py-1.5 text-sm dark:border-zinc-800">
      <span className="w-14 shrink-0 text-xs text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

const FIELD = "w-full bg-transparent py-1 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-70 dark:text-zinc-100";

/**
 * The Social Alert email, written from the alert in the team's template and edited here as it will look: the body is the
 * email itself, typed into directly. Saving writes it to the draft in the analyst's own Gmail, where it is sent from;
 * with the switch "Send alert emails from the Console" on it can be sent from here too, after a question that says who
 * it goes to (the Testing recipients only, while Testing is on). The body is a page of its own with scripts off; what is
 * saved or sent is cleaned again by the server.
 */
export function EmailComposer({ caseId, email, canAct, onSaved }: { caseId: string; email: EmailDraft; canAct: boolean; onSaved: (email: EmailDraft) => void }) {
  const { toast } = useApp();
  const frame = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState(email.html);  // what the body was loaded from: set again only to start over
  const [frameKey, setFrameKey] = useState(0);
  const [subject, setSubject] = useState(email.subject);
  const [to, setTo] = useState(email.to.join(", "));
  const [cc, setCc] = useState(email.cc.join(", "));
  const [bcc, setBcc] = useState(email.bcc.join(", "));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const sent = email.status === "sent";
  const editable = canAct && !sent;

  const arm = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.designMode = editable ? "on" : "off";
    doc.addEventListener("input", () => setDirty(true));
  }, [editable]);
  useEffect(() => { arm(); }, [arm]);

  const load = (next: EmailDraft) => {
    setSource(next.html); setFrameKey((k) => k + 1); setSubject(next.subject);
    setTo(next.to.join(", ")); setCc(next.cc.join(", ")); setBcc(next.bcc.join(", ")); setDirty(false);
  };
  const exec = (command: string, value?: string) => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    frame.current?.contentWindow?.focus();
    doc.execCommand(command, false, value);
    setDirty(true);
  };
  const link = () => {
    const url = window.prompt("Link address (https://...)");
    if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) exec("createLink", url.trim());
  };
  const save = async () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    setBusy("save");
    try {
      const res = await apiSend<{ email: EmailDraft }>("put", `/workspace/${caseId}/email`, {
        subject, to: split(to), cc: split(cc), bcc: split(bcc), html: `<!DOCTYPE html>${doc.documentElement.outerHTML}` });
      setDirty(false);
      onSaved(res.email);
      toast(res.email.testing.on ? "Draft written to your Gmail (Testing: addressed to the testing recipients only)" : "Draft written to your Gmail");
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const people = split(to).length + split(cc).length + split(bcc).length;
  // Nothing is sent to nobody: an email needs its own recipients even while Testing sends it to the testing recipients instead
  const nobody = people === 0 ? "The email has no recipients in To, Cc or Bcc"
    : email.testing.on && email.testing.recipients === 0 ? "Testing is on and no testing recipient is set: nothing can be sent" : "";
  const send = async () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const asked = email.testing.on
      ? `Send this email now, from your Gmail?\n\nTesting is ON: it goes to your ${email.testing.recipients} testing recipient${email.testing.recipients === 1 ? "" : "s"} only, not to the ${people} ${people === 1 ? "person" : "people"} in To, Cc and Bcc.`
      : `Send this email now, from your Gmail, to ${people} ${people === 1 ? "recipient" : "recipients"}?\n\nIt goes out as it is written here and cannot be unsent.`;
    if (!window.confirm(asked)) return;
    setBusy("send");
    try {
      const res = await apiSend<{ email: EmailDraft }>("post", `/workspace/${caseId}/email/send`, {
        subject, to: split(to), cc: split(cc), bcc: split(bcc), html: `<!DOCTYPE html>${doc.documentElement.outerHTML}` });
      setDirty(false);
      onSaved(res.email);
      toast(res.email.testing.on ? "Sent from your Gmail (Testing: to the testing recipients only)" : "Sent from your Gmail");
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };
  const reset = async () => {
    if (!window.confirm("Start over from the alert? Your edits to this email are dropped.")) return;
    setBusy("reset");
    try {
      const res = await apiSend<{ email: EmailDraft }>("post", `/workspace/${caseId}/email/reset`, {});
      onSaved(res.email); load(res.email);
    } catch (err) { toast((err as ApiError).message, "error"); } finally { setBusy(""); }
  };

  const status = STATUS[email.status] ?? STATUS.new;
  const icon = "size-4";
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">Social Alert email</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <Badge tone="zinc" title="The template this email was written in">{email.templates[email.template] ?? "Social Alert"}</Badge>
        {dirty && <Badge tone="violet">Unsaved changes</Badge>}
        <span className="ml-auto text-xs text-zinc-500">
          {sent ? `Sent ${fmtDateTime(email.sent_at)}` : email.saved_at ? `Saved ${fmtDateTime(email.saved_at)}` : "Written from the alert"}
        </span>
      </div>

      {email.testing.on && !sent && (
        <p className="border-b border-zinc-200 bg-blue-50 px-4 py-2 text-xs text-blue-900 dark:border-zinc-800 dark:bg-blue-900/20 dark:text-blue-200">
          Testing is ON: the draft in Gmail is addressed to {email.testing.recipients ? `your ${email.testing.recipients} testing recipient${email.testing.recipients === 1 ? "" : "s"}` : "nobody (no testing recipient is set)"}, not to the people below.
          {email.can_send ? (email.testing.recipients ? " Sending from here goes to them only." : " Nothing can be sent from here until one is set.") : ""}
        </p>
      )}
      {!email.gmail.connected && !sent && (
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-violet-50 px-4 py-2 text-xs text-violet-900 dark:border-zinc-800 dark:bg-violet-900/20 dark:text-violet-200">
          Your Gmail is not connected, so the draft can't be written there yet. Your edits are still kept here.<GmailButton />
        </div>
      )}
      {email.error && email.status === "failed" && <Alert tone="rose" className="m-3">{email.error}</Alert>}
      {email.others.length > 0 && (
        <p className="border-b border-zinc-200 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          Also on this alert: {email.others.map((o) => `${o.analyst} (${o.status.toLowerCase()})`).join(", ")}. Send only one.
        </p>
      )}

      <Line label="From"><span className="py-1 text-zinc-700 dark:text-zinc-300">{email.from}</span></Line>
      <Line label="To"><input className={FIELD} value={to} disabled={!editable} onChange={(e) => { setTo(e.target.value); setDirty(true); }} placeholder="Addresses, separated by commas" aria-label="To" /></Line>
      <Line label="Cc"><input className={FIELD} value={cc} disabled={!editable} onChange={(e) => { setCc(e.target.value); setDirty(true); }} aria-label="Cc" /></Line>
      <Line label="Bcc"><input className={FIELD} value={bcc} disabled={!editable} onChange={(e) => { setBcc(e.target.value); setDirty(true); }} aria-label="Bcc" /></Line>
      <Line label="Subject"><input className={cx(FIELD, "font-medium")} value={subject} disabled={!editable} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} aria-label="Subject" /></Line>
      {(email.groups.length > 0 || email.missing.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
          <span className="text-zinc-500">Routed to</span>
          {email.groups.map((g) => <Badge key={g} tone="blue" title={email.reasons[g]}>{g}</Badge>)}
          {email.missing.map((g) => <Badge key={g} tone="violet" title="No recipients are set for this group yet">{g}: no recipients</Badge>)}
        </div>
      )}

      {editable && (
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-800/60">
          <Tool label="Undo" onClick={() => exec("undo")}><Undo2 className={icon} /></Tool>
          <Tool label="Redo" onClick={() => exec("redo")}><Redo2 className={icon} /></Tool>
          <span aria-hidden className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-600" />
          <Tool label="Bold" onClick={() => exec("bold")}><Bold className={icon} /></Tool>
          <Tool label="Italic" onClick={() => exec("italic")}><Italic className={icon} /></Tool>
          <Tool label="Underline" onClick={() => exec("underline")}><Underline className={icon} /></Tool>
          <Tool label="Clear formatting" onClick={() => exec("removeFormat")}><RemoveFormatting className={icon} /></Tool>
          <span aria-hidden className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-600" />
          <Tool label="Bulleted list" onClick={() => exec("insertUnorderedList")}><List className={icon} /></Tool>
          <Tool label="Numbered list" onClick={() => exec("insertOrderedList")}><ListOrdered className={icon} /></Tool>
          <Tool label="Add a link" onClick={link}><Link2 className={icon} /></Tool>
          <Tool label="Remove the link" onClick={() => exec("unlink")}><Unlink className={icon} /></Tool>
          <span className="ml-auto pr-2 text-xs text-zinc-500">Click into the email and type: it is edited as it will look.</span>
        </div>
      )}
      <iframe key={frameKey} ref={frame} title="Email body" sandbox="allow-same-origin" srcDoc={source} onLoad={arm}
        className="h-[56vh] min-h-[24rem] w-full bg-white" />

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <Button variant="primary" icon={<Save className="size-4" />} disabled={!editable || busy !== ""} loading={busy === "save"} onClick={save}>
          {email.status === "new" || email.status === "failed" || email.status === "discarded" ? "Save as a draft in Gmail" : "Update the draft in Gmail"}
        </Button>
        {email.can_send && editable && email.gmail.connected && (
          <Button icon={<Send className="size-4" />} disabled={nobody !== "" || busy !== ""} loading={busy === "send"} onClick={send}
            title={nobody || "Saves the email as it is written here and sends it from your Gmail"}>
            {email.testing.on ? "Send to the testing recipients" : "Send now"}
          </Button>
        )}
        {email.status !== "new" && email.gmail.connected && (
          <a href={email.gmail.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
            {sent ? "Open in Gmail" : "Open in Gmail to send"}<ExternalLink className="size-3.5" />
          </a>
        )}
        {editable && <Button variant="ghost" icon={<RotateCcw className="size-4" />} loading={busy === "reset"} onClick={reset}>Start over from the alert</Button>}
        {email.notes.length > 0 && <span className="w-full text-xs text-zinc-500">{email.notes.join(" ")}</span>}
      </div>
    </div>
  );
}
