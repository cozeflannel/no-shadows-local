import { Navigate, Route, Routes } from "react-router";

import { GmailButton } from "./components/GmailButton";
import { Layout } from "./components/Layout";
import { Alert, Spinner } from "./components/ui";
import { useApp } from "./context";
import ActivityPage from "./pages/Activity";
import AgentPage from "./pages/Agent";
import CampaignsPage from "./pages/Campaigns";
import CasesPage from "./pages/Cases";
import ChatSpacesPage from "./pages/ChatSpaces";
import DashboardPage from "./pages/Dashboard";
import EscalationsPage from "./pages/Escalations";
import FeedPage from "./pages/Feed";
import HelpPage from "./pages/Help";
import KnowledgePage from "./pages/Knowledge";
import LearningPage from "./pages/Learning";
import OutboxPage from "./pages/Outbox";
import OverviewPage from "./pages/Overview";
import ParityPage from "./pages/Parity";
import RostersPage from "./pages/Rosters";
import SettingsPage from "./pages/Settings";
import SuppressedPage from "./pages/Suppressed";
import TempCheckPage from "./pages/TempCheck";
import WelcomePage from "./pages/Welcome";
import WorkforcePage from "./pages/Workforce";

export default function App() {
  const { me, gmail, bootError } = useApp();

  if (bootError && !me) {
    if (bootError.status === 401) return <WelcomePage state="signed-out" />;
    return (
      <WelcomePage state="no-access">
        <Alert tone="rose" title="The Console API can't be reached">{bootError.message}</Alert>
      </WelcomePage>
    );
  }
  if (!me) return <Spinner label="Loading" />;
  if (!me.can_view && gmail?.mailbox === "agent") {
    return (
      <WelcomePage state="no-access">
        <Alert tone="blue" title="This is the agent's own account">
          {me.email} only connects its mailbox here, once, so the email doorbell can send. The rest of the Console is for analysts and Incident Managers.
          <div className="mt-3"><GmailButton /></div>
        </Alert>
      </WelcomePage>
    );
  }
  if (!me.can_view) {
    return (
      <WelcomePage state="no-access">
        <Alert tone="amber" title="No access yet">{me.email} is not an analyst, an Incident Manager or in a viewer domain. Ask an admin to add you under Settings, Analysts & roles.</Alert>
      </WelcomePage>
    );
  }

  return (
    <Routes>
      <Route path="/welcome" element={<WelcomePage />} />
      <Route path="*" element={
        <Layout>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/feed" element={<FeedPage />} />
            <Route path="/feed/:caseId" element={<FeedPage />} />
            <Route path="/review" element={<Navigate to="/feed?view=review" replace />} />
            <Route path="/chat" element={<ChatSpacesPage />} />
            <Route path="/agent" element={<AgentPage />} />
            <Route path="/agent/:sessionId" element={<AgentPage />} />
            <Route path="/temp-check" element={<TempCheckPage />} />
            <Route path="/temp-check/:checkId" element={<TempCheckPage />} />
            <Route path="/workforce" element={<WorkforcePage />} />
            <Route path="/rosters" element={<RostersPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/learning" element={<LearningPage />} />
            <Route path="/campaigns" element={<CampaignsPage />} />
            <Route path="/cases" element={<CasesPage />} />
            <Route path="/cases/:caseId" element={<CasesPage />} />
            <Route path="/escalations" element={<EscalationsPage />} />
            <Route path="/suppressed" element={<SuppressedPage />} />
            <Route path="/parity" element={<ParityPage />} />
            <Route path="/outbox" element={<OutboxPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/breakdowns" element={<OverviewPage />} />
            <Route path="/overview" element={<Navigate to="/" replace />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/help/:topic" element={<HelpPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:key" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      } />
    </Routes>
  );
}
