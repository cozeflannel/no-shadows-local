import { useEffect, useState } from "react";
import { useApi } from "../api/hooks";
import { Card, PageHeader, Spinner, EmptyState } from "../components/ui";
import { fmtDateTime } from "../lib/format";

type ChatMessage = {
  id: string;
  ts: string;
  kind: "event" | "outbox";
  type: string;
  text: string;
  case_id?: string;
  actor?: string;
  delivered?: boolean;
};

export default function ChatPage() {
  const { data, loading, error, reload } = useApi<{ messages: ChatMessage[] }>("/chat/stream", { limit: 100 });
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (data?.messages) setMessages(data.messages);
  }, [data]);

  useEffect(() => {
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [reload]);

  return (
    <div>
      <PageHeader title="Chat" description="Live stream of messages from the Burson and analyst spaces. Refreshes every 5 seconds." />
      {loading && !messages.length && <Spinner />}
      {error && <div className="text-rose-600 text-sm">{error.message}</div>}
      {!loading && !messages.length && (
        <EmptyState title="No messages yet">
          Messages appear here once the agent records them from the Chat spaces.
        </EmptyState>
      )}
      <div className="space-y-3">
        {messages.map((m) => (
          <Card key={m.id} className="p-3">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span>{fmtDateTime(m.ts)}</span>
              <span className="font-mono">{m.type}</span>
              {m.kind === "outbox" && (
                <span className={m.delivered ? "text-green-600" : "text-amber-600"}>
                  {m.delivered ? "delivered" : "pending"}
                </span>
              )}
            </div>
            <div className="mt-1 whitespace-pre-wrap text-sm">{m.text}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
