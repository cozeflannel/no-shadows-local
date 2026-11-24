import { Navigate, useSearchParams } from "react-router";

/**
 * The Agent alerts page is now three places. The alerts the agent raised, and what it looked at and did not raise, are views
 * of the Review feed; the sources it reads and the rules it reads them by are under Settings (pages/settings/OwnAlerts.tsx).
 *
 * Links made before that still land here and are sent on: the Confirm and False positive links on an alert in Chat
 * (triage_agent/ownalerts/raise_.py: /own-alerts?decision=<id>&verdict=<verdict>), and anyone's bookmark of a tab.
 */
export default function OwnAlertsPage() {
  const [search] = useSearchParams();
  const tab = search.get("tab");
  if (tab === "sources") return <Navigate to="/settings/own-sources" replace />;
  if (tab === "rules") return <Navigate to="/settings/own-rules" replace />;

  const next = new URLSearchParams({ kind: "agent" });
  const decision = search.get("decision");
  const verdict = search.get("verdict");
  if (tab === "passed") next.set("view", "passed");
  else if (decision) next.set("view", "all");  // a judged alert is no longer under To judge: open it among everything raised
  if (decision) next.set("agent", decision);
  if (decision && (verdict === "TRUE_POSITIVE" || verdict === "FALSE_POSITIVE")) next.set("verdict", verdict);
  return <Navigate to={`/feed?${next}`} replace />;
}
