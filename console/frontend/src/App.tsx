import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";

import { GmailButton } from "./components/GmailButton";
import { Layout } from "./components/Layout";
import { Alert, Spinner } from "./components/ui";
import { useApp } from "./context";
import { LiveProvider } from "./lib/live";
import DashboardPage from "./pages/Dashboard";
import FeedPage from "./pages/Feed";
import WelcomePage from "./pages/Welcome";

// Every page but the ones a person lands on is loaded when it is first opened, so the Console's first file stays small.
const ActivityPage = lazy(() => import("./pages/Activity"));
const AdminPage = lazy(() => import("./pages/Admin"));
const AiPage = lazy(() => import("./pages/Ai"));
const AgentPage = lazy(() => import("./pages/Agent"));
const CampaignsPage = lazy(() => import("./pages/Campaigns"));
const CasesPage = lazy(() => import("./pages/Cases"));
const ComparePage = lazy(() => import("./pages/Compare"));
const ConnectionsPage = lazy(() => import("./pages/Connections"));
const EarlyPage = lazy(() => import("./pages/Early"));
const ChatSpacesPage = lazy(() => import("./pages/ChatSpaces"));
const EscalationsPage = lazy(() => import("./pages/Escalations"));
const HelpPage = lazy(() => import("./pages/Help"));
const KnowledgePage = lazy(() => import("./pages/Knowledge"));
const LearningPage = lazy(() => import("./pages/Learning"));
const OutboxPage = lazy(() => import("./pages/Outbox"));
const OwnAlertsPage = lazy(() => import("./pages/OwnAlerts"));
const OverviewPage = lazy(() => import("./pages/Overview"));
const ParityPage = lazy(() => import("./pages/Parity"));
const RostersPage = lazy(() => import("./pages/Rosters"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const RoutingPage = lazy(() => import("./pages/Routing"));
const StoriesPage = lazy(() => import("./pages/Stories"));
const SuppressedPage = lazy(() => import("./pages/Suppressed"));
const TempCheckPage = lazy(() => import("./pages/TempCheck"));
const WorkforcePage = lazy(() => import("./pages/Workforce"));

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
        <LiveProvider>
        <Layout>
          <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/feed" element={<FeedPage />} />
            <Route path="/feed/:caseId" element={<FeedPage />} />
            <Route path="/review" element={<Navigate to="/feed?view=review" replace />} />
            <Route path="/stories" element={<StoriesPage />} />
            <Route path="/stories/:storyId" element={<StoriesPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/early" element={<EarlyPage />} />
            <Route path="/own-alerts" element={<OwnAlertsPage />} />
            <Route path="/routing" element={<RoutingPage />} />
            <Route path="/ai" element={<AiPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/connections/:toolKey" element={<ConnectionsPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/:tab" element={<AdminPage />} />
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
          </Suspense>
        </Layout>
        </LiveProvider>
      } />
    </Routes>
  );
}
