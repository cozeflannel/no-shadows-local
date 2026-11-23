import { Mail, MailCheck, MailWarning, MailX } from "lucide-react";
import { useState } from "react";

import { apiSend } from "../api/client";
import { useApp } from "../context";
import { GMAIL_SCOPE_LABEL } from "../lib/labels";
import { Button, Modal, Tooltip } from "./ui";

/**
 * Header control: Gmail connection status for the signed-in user, connect / disconnect.
 * IMs connect their drafting mailbox; the Triage Agent account (mailbox "agent") connects the
 * mailbox the email doorbell sends from.
 */
export function GmailButton() {
  const { gmail, me, refreshGmail, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!me || !gmail) return null;
  const isAgent = gmail.mailbox === "agent";

  if (!gmail.available) {
    return (
      <Tooltip content={gmail.message}>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-500 dark:border-zinc-700">
          <MailX className="size-3.5" /> Gmail unavailable
        </span>
      </Tooltip>
    );
  }

  const connect = () => {
    if (!gmail.oauth_configured) {
      toast("The Gmail OAuth client isn't configured on this deployment (TRIAGE_OAUTH_CLIENT).", "error");
      return;
    }
    window.location.assign("/api/gmail/connect");
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await apiSend("delete", "/gmail");
      toast(isAgent ? "The agent's mailbox is disconnected. Chat is no longer told by email when a post is waiting." : "Gmail disconnected. Auto-drafts are paused for you.", "info");
      refreshGmail();
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't disconnect Gmail", "error");
    } finally {
      setBusy(false);
    }
  };

  if (gmail.connected && gmail.needs_reconnect) {
    const missing = (gmail.missing_scopes ?? []).map((s) => GMAIL_SCOPE_LABEL[s] ?? s).join("; ");
    return (
      <Tooltip content={`${gmail.message}${missing ? ` Missing: ${missing}.` : ""}`}>
        <Button size="sm" icon={<MailWarning className="size-3.5 text-violet-600 dark:text-violet-300" />} onClick={connect}>
          {isAgent ? "Reconnect agent mailbox" : "Reconnect Gmail"}
        </Button>
      </Tooltip>
    );
  }

  if (gmail.connected) {
    const label = gmail.mode === "fake" ? "Gmail (simulated)" : isAgent ? "Agent mailbox connected" : "Gmail connected";
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-300"
          title={gmail.message}
        >
          <MailCheck className="size-3.5" /> {label}
        </button>
        <Modal open={open} onClose={() => setOpen(false)} title={isAgent ? "The agent's mailbox" : "Gmail connection"}
          footer={<>
            <Button onClick={() => setOpen(false)}>Close</Button>
            {gmail.mode !== "fake" && <Button variant="danger" loading={busy} onClick={disconnect}>Disconnect</Button>}
          </>}
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{gmail.message}</p>
          <p className="mt-2 text-sm text-zinc-500">Account: <span className="font-mono">{gmail.email}</span> · mode <span className="font-mono">{gmail.mode}</span></p>
          <p className="mt-2 text-xs text-zinc-500">
            {isAgent
              ? "From this account the agent only sends the email that tells Chat a post is waiting. It can't read the mailbox."
              : "The agent only creates drafts and checks whether they were sent. You always send."}
            {gmail.scopes?.length ? ` Permissions: ${gmail.scopes.map((s) => GMAIL_SCOPE_LABEL[s] ?? s).join("; ")}.` : ""}
          </p>
        </Modal>
      </>
    );
  }

  const allowed = isAgent || me.can_act;
  const hint = !allowed
    ? "Only IMs and analysts connect Gmail."
    : gmail.can_connect ? gmail.message : "The OAuth client isn't configured on this deployment.";
  return (
    <Tooltip content={hint}>
      <Button size="sm" variant="primary" icon={<Mail className="size-3.5" />} onClick={connect} disabled={!allowed}>
        {isAgent ? "Connect the agent's mailbox" : "Connect Gmail"}
      </Button>
    </Tooltip>
  );
}
