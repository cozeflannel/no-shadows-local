import { Bot, ShieldAlert } from "lucide-react";
import { Navigate, Route, Routes } from "react-router";

import { GmailButton } from "./components/GmailButton";
import { Layout } from "./components/Layout";
import { Alert, Spinner } from "./components/ui";
import { useApp } from "./context";
import ActivityPage from "./pages/Activity";
import CasesPage from "./pages/Cases";
import EscalationsPage from "./pages/Escalations";
import LearningPage from "./pages/Learning";
import OutboxPage from "./pages/Outbox";
import OverviewPage from "./pages/Overview";
import ParityPage from "./pages/Parity";
import ReviewQueuePage from "./pages/ReviewQueue";
import RostersPage from "./pages/Rosters";
import SettingsPage from "./pages/Settings";
import SuppressedPage from "./pages/Suppressed";
import TestChannelPage from "./pages/TestChannel";

export default function App() {
  const { me, gmail, bootError } = useApp();

  if (bootError && !me) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Alert tone="rose" title={bootError.status === 401 ? "Not signed in" : "The Console API isn't reachable"}>
          {bootError.message}
        </Alert>
      </div>
    );
  }
  if (!me) return <Spinner label="Loading the Agent Console…" />;
  if (!me.can_view && gmail?.mailbox === "agent") {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 p-10 text-center">
        <Bot className="size-10 text-zinc-400" />
        <h1 className="text-lg font-semibold">Triage Agent account</h1>
        <p className="text-sm text-zinc-500">
          {me.email} is the agent's own account. Connect its mailbox once so the email doorbell can send (gmail.send only);
          the rest of the Console is for analysts and Incident Managers.
        </p>
        <GmailButton />
      </div>
    );
  }
  if (!me.can_view) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 p-10 text-center">
        <ShieldAlert className="size-10 text-zinc-400" />
        <h1 className="text-lg font-semibold">No access</h1>
        <p className="text-sm text-zinc-500">{me.email} isn't an SLRR analyst, Incident Manager or Google user. Ask an admin to add you in Settings → Analysts & roles.</p>
      </div>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/overview" element={<Navigate to="/" replace />} />
        <Route path="/test" element={<TestChannelPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/cases" element={<CasesPage />} />
        <Route path="/cases/:caseId" element={<CasesPage />} />
        <Route path="/review" element={<ReviewQueuePage />} />
        <Route path="/suppressed" element={<SuppressedPage />} />
        <Route path="/parity" element={<ParityPage />} />
        <Route path="/escalations" element={<EscalationsPage />} />
        <Route path="/rosters" element={<RostersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/learning" element={<LearningPage />} />
        <Route path="/outbox" element={<OutboxPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
