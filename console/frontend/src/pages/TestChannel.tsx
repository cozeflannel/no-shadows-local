import { MessageSquarePlus, Send, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { apiSend } from "../api/client";
import type { CaseSummary, Escalation } from "../api/types";
import { EscalationView } from "../components/EscalationView";
import { Alert, Badge, Button, Card, Field, PageHeader, Select, Textarea, VerdictBadge } from "../components/ui";

const PRESETS: { label: string; channel: "test_burson" | "clean_chat"; text: string }[] = [
  {
    label: "Real Burson P0 Alert — Search Perceived Bias (Paris Riots 2026)",
    channel: "test_burson",
    text: `🚨THIS ALERT MEETS P0 CRITERIA🚨

⬛SOCIAL ALERT⬛: Search | Alleged Bias in Search Reporting for Paris Riots 2026 | X | 1 Engagements
[Name]: Alleged Bias in Search Reporting for Paris Riots 2026 / New / not previously reported over the past 14 days
[Engagement]: VERY LOW (1 engagements)
[Product]: Search
[Social Network]: X
[Exposure Tag]: Product - Perceived bias
[Sensitive Topic]: -
[KOF]: No

X user @WasSamLowryEsq (652 followers) criticized Search for allegedly presenting a curated selection of results for “Paris riots 2026,” claiming that the results mainly showed white protesters despite videos allegedly depicting African youths burning vehicles and assaulting citizens. The user accused Google of contributing to a misleading account of events.

[Link]: https://x.com/WasSamLowryEsq/status/2109952063492993159

As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.
Note: Brand-Social-Sends@ and SLRR-updates@ includes xWF vendors that support Brand Social's 24/7 Social Listening & Rapid Response. Please consider removing these aliases in NTK replies.

[Time/Date Post Went Live]: October 13, 2026, 3:19 AM

[Code]: Product - Perceived bias,1,WasSamLowryEsq,-,Search,New / not previously reported over the past 14 days

Please note: screenshots are not available for Reddit, TikTok, Facebook or Instagram.`,
  },
  {
    label: "Real Burson P1 Alert — AI Overviews Unexpected Responses (29,425 Engagements)",
    channel: "test_burson",
    text: `THIS ALERT MEETS P1 CRITERIA

🟥SOCIAL ALERT🟥: AI Overviews | Criticism against AI Overviews | X | 29425 Engagements
[Name]: Criticism against AI Overviews / Ongoing Issue
[Engagement]: HIGH (29425 engagements)
[Product]: AI Overviews
[Social Network]: X
[Exposure Tag]: Product - Unexpected Responses
[Sensitive Topic]: -
[KOF]: No

X user edervolcelazz (195 followers) shared a post featuring AI Overview displaying the query “keep f**kin my girl bro, idc” with a reply “Okay, LOL.” The post uses the screenshot alongside the caption “Im not even talking to you ni**a.”

[Link]: https://x.com/edervolcelazz/status/2109566527900926417

As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.
Note: Brand-Social-Sends@ and SLRR-updates@ includes xWF vendors that support Brand Social's 24/7 Social Listening & Rapid Response. Please consider removing these aliases in NTK replies.

[Time/Date Post Went Live]: October 12, 2026, 1:47 AM

[Code]: Product - Unexpected Responses,29425,edervolcelazz,-,AI Overviews,Ongoing Issue

Please note: screenshots are not available for Reddit, TikTok, Facebook or Instagram.`,
  },
  {
    label: "Real Burson P2 Alert — Maps/Geo Meme (2,011 Engagements)",
    channel: "test_burson",
    text: `THIS ALERT MEETS P2 CRITERIA

🟥SOCIAL ALERT🟥: Maps/Geo | Criticism of Google Maps | X | 2011 Engagements
[Name]: Criticism of Google Maps / Ongoing Issue
[Engagement]: HIGH (2011 engagements)
[Product]: Maps/Geo
[Social Network]: X
[Exposure Tag]: Product - Meme about Google products
[Sensitive Topic]: -
[KOF]: No

X user deem_big65585 (4389 followers) shared a post with a meme claiming that “Google Maps saves you from 98% of getting lost,” while illustrating the remaining 2% with a video of a black cat making animated, human-like gestures.

[Link]: https://x.com/deem_big65585/status/2109578853681176681

As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.
Note: Brand-Social-Sends@ and SLRR-updates@ includes xWF vendors that support Brand Social's 24/7 Social Listening & Rapid Response. Please consider removing these aliases in NTK replies.

[Time/Date Post Went Live]: October 12, 2026, 2:36 AM

[Code]: Product - Meme about Google products,2011,deem_big65585,-,Maps/Geo,Ongoing Issue

Please note: screenshots are not available for Reddit, TikTok, Facebook or Instagram.`,
  },
  {
    label: "Analyst Shift Sign-In (Natural Language, No @Mention)",
    channel: "clean_chat",
    text: "Hey team, on alerts from 12pm to 6pm PST (3pm to 9pm EST)",
  },
];

interface PushResponse {
  ok: boolean;
  outputs: Record<string, string>;
  data: Record<string, unknown>;
  summary?: CaseSummary | null;
  escalations?: Escalation[];
}

export default function TestChannelPage() {
  const [channel, setChannel] = useState<"test_burson" | "clean_chat">("test_burson");
  const [text, setText] = useState(PRESETS[0].text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<PushResponse | null>(null);

  const pushMessage = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiSend<PushResponse>("post", "/test/push", {
        channel,
        text,
      });
      setResult(res);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reactEmoji = async (emoji: string) => {
    const cid = result?.outputs?.case_id || result?.summary?.case_id;
    if (!cid) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await apiSend<PushResponse>("post", "/test/react", {
        case_id: cid,
        emoji,
      });
      setResult((prev) => ({
        ...res,
        outputs: { ...(prev?.outputs ?? {}), ...res.outputs, clean_text: prev?.outputs?.clean_text || res.outputs.clean_text },
      }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const caseId = result?.outputs?.case_id || result?.summary?.case_id;
  const forwardedCard = result?.outputs?.clean_text || result?.outputs?.dm_text;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Live Test Channel"
        description="Push any Burson message, shift sign-in, or analyst reaction to test the live Vertex AI Gemini + BigQuery triage pipeline without touching the real Burson chat."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="space-y-3 lg:col-span-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">1. Push Incoming Message</h2>
            <Badge tone="emerald">Stealth Burson Mode Active</Badge>
          </div>

          <Field label="Load a real Burson message or shift sign-in">
            <Select
              value=""
              onChange={(e) => {
                const p = PRESETS[Number(e.target.value)];
                if (p) {
                  setChannel(p.channel);
                  setText(p.text);
                }
              }}
            >
              <option value="">Choose a real message from Burson V3…</option>
              {PRESETS.map((p, idx) => (
                <option key={p.label} value={idx}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Simulated Source Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as "test_burson" | "clean_chat")}>
              <option value="test_burson">Incoming Alert Feed (Burson V3 / Test Space)</option>
              <option value="clean_chat">Google Analyst Space (Shift Sign-In / @Triage Question)</option>
            </Select>
          </Field>

          <Field label="Message Text">
            <Textarea
              rows={14}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste a Burson message or shift sign-in here…"
              className="font-mono text-xs"
            />
          </Field>

          {err && <Alert tone="rose" title="Error">{err}</Alert>}

          <Button variant="primary" icon={<Send className="size-4" />} disabled={busy || !text.trim()} onClick={pushMessage}>
            {busy ? "Running Live Vertex AI + BigQuery Triage (5–15s)…" : "Push Message to Agent"}
          </Button>
        </Card>

        <div className="space-y-4 lg:col-span-7">
          {!result ? (
            <Card className="flex h-64 flex-col items-center justify-center text-center text-zinc-500">
              <MessageSquarePlus className="mb-2 size-8 text-zinc-400" />
              <p className="text-sm font-medium">Push a message on the left to see the agent's live response</p>
              <p className="text-xs text-zinc-400">
                You'll see the Stealth Burson check, the forwarded Google Analyst post, and the Social Alert HTML email / T&S output.
              </p>
            </Card>
          ) : (
            <>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck className="size-4 text-emerald-600" />
                  <span className="text-sm font-semibold">Stealth Check & Triage Verdict</span>
                  {caseId && <Badge tone="blue">{caseId}</Badge>}
                  {result.summary?.verdict && <VerdictBadge verdict={result.summary.verdict} />}
                  <Badge tone={result.outputs.has_burson === "yes" ? "rose" : "emerald"}>
                    Sent to Burson Space: {result.outputs.has_burson === "yes" ? "YES" : "NONE (Silent)"}
                  </Badge>
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">{result.outputs.summary}</p>
              </Card>

              {forwardedCard && (
                <Card className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {result.outputs.clean_text
                          ? "2. Forwarded to Google Analyst Space (SLRR Triaged Alerts)"
                          : "2. Sent to On-Shift Google Analyst DM (Review Queue)"}
                      </h3>
                      <p className="text-xs text-zinc-500">Verified against BigQuery Sonar & Collection Rules</p>
                    </div>
                    {caseId && (
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" onClick={() => reactEmoji("📦")} disabled={busy}>
                          📦 Social Alert Email
                        </Button>
                        <Button size="sm" onClick={() => reactEmoji("✍️")} disabled={busy}>
                          ✍️ Trust & Safety
                        </Button>
                        <Button size="sm" onClick={() => reactEmoji("📣")} disabled={busy}>
                          📣 Channel Owner
                        </Button>
                        <Button size="sm" onClick={() => reactEmoji("✅")} disabled={busy}>
                          ✅ Confirm Send
                        </Button>
                      </div>
                    )}
                  </div>
                  <pre className="scroll-thin max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-sans text-xs leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                    {forwardedCard}
                  </pre>
                </Card>
              )}

              {result.outputs.reply_text && (
                <Card className="space-y-2">
                  <h3 className="text-sm font-semibold">Agent Thread Reply (in Google Analyst Space)</h3>
                  <pre className="whitespace-pre-wrap rounded-lg border border-blue-200 bg-blue-50/40 p-3 font-sans text-xs leading-relaxed text-zinc-800 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-zinc-200">
                    {result.outputs.reply_text}
                  </pre>
                </Card>
              )}

              {(result.escalations ?? []).length > 0 && (
                <Card className="space-y-3">
                  <h3 className="text-sm font-semibold">3. Social Alert HTML Email & Trust and Safety Output</h3>
                  <div className="space-y-4">
                    {(result.escalations ?? []).map((esc) => (
                      <EscalationView key={esc.escalation_id} esc={esc} />
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
