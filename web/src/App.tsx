import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { AccountsPage } from './pages/AccountsPage';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { ImportPage } from './pages/ImportPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { TransfersPage } from './pages/TransfersPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { SignupPage } from './pages/SignupPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { BudgetsPage } from './pages/BudgetsPage';
import { GoalsPage } from './pages/GoalsPage';
import { BillsPage } from './pages/BillsPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { UncategorizedPage } from './pages/UncategorizedPage';
import { VehiclesPage } from './pages/VehiclesPage';
import { RoutesPage } from './pages/RoutesPage';
import { SettingsPage } from './pages/SettingsPage';
import { HealthPage } from './pages/HealthPage';
import { BackupsPage } from './pages/BackupsPage';
import { ReportsPage } from './pages/ReportsPage';
import { InviteAcceptPage } from './pages/InviteAcceptPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { SystemPage } from './pages/SystemPage';
import { RetirementPage } from './pages/RetirementPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { AssistantPage } from './pages/AssistantPage';
import { SharingPage } from './pages/SharingPage';
import { CalendarPage } from './pages/CalendarPage';
import { TaxYearPage } from './pages/TaxYearPage';
import { AnomaliesPage } from './pages/AnomaliesPage';
import { BillingPage } from './pages/BillingPage';
import { ThemeToggle } from './components/ThemeToggle';
import { MobileBar, SidebarBackdrop, useMobileDrawer } from './components/MobileBar';
import { InstallPrompt, OfflineIndicator } from './components/InstallPrompt';
import { TrialBanner } from './components/TrialBanner';

type AuthState =
  | 'loading'
  | 'needs-setup'
  | 'needs-login'
  | 'authenticated-tenant'
  | 'authenticated-super';

export function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);
  const location = useLocation();
  // /invite/:token is a public landing — skip the auth gate entirely.
  const isInviteRoute = location.pathname.startsWith('/invite/');
  // 0.16.0 — /signup and /verify-email are also public.
  const isSignupRoute = location.pathname === '/signup';
  const isVerifyRoute = location.pathname.startsWith('/verify-email');
  // 0.16.2 — /forgot-password and /reset-password are public.
  const isForgotPasswordRoute = location.pathname === '/forgot-password';
  const isResetPasswordRoute = location.pathname.startsWith('/reset-password');

  const refreshAuth = useCallback(async () => {
    try {
      const status = await api.authStatus();
      setSignupEnabled(status.signupEnabled);
      setSupportUrl(status.supportUrl);
      if (!status.isSetup) {
        setAuthState('needs-setup');
        return;
      }
      if (!status.authenticated) {
        setAuthState('needs-login');
        return;
      }
      // Authenticated — but which kind? Super-admin sessions never see
      // the financial dashboard; tenant sessions never see the system
      // console.
      const me = await api.authMe();
      setAuthState(me.user.is_super_admin ? 'authenticated-super' : 'authenticated-tenant');
    } catch {
      // Network-down or server-down — show the login screen so the user
      // can retry. Avoids a permanent blank app if /status briefly fails.
      setAuthState('needs-login');
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  if (isInviteRoute) {
    return (
      <Routes>
        <Route path="/invite/:token" element={<InviteAcceptPage />} />
      </Routes>
    );
  }
  // 0.16.0 — /signup and /verify-email are reachable regardless of
  // auth state (so a half-signed-up user can finish the dance).
  if (isVerifyRoute) {
    return (
      <Routes>
        <Route
          path="/verify-email"
          element={<VerifyEmailPage onAuthenticated={refreshAuth} />}
        />
      </Routes>
    );
  }
  if (isSignupRoute) {
    return <SignupPage supportUrl={supportUrl} />;
  }
  if (isForgotPasswordRoute) {
    return <ForgotPasswordPage supportUrl={supportUrl} />;
  }
  if (isResetPasswordRoute) {
    return (
      <Routes>
        <Route
          path="/reset-password"
          element={<ResetPasswordPage supportUrl={supportUrl} />}
        />
      </Routes>
    );
  }
  if (authState === 'loading') {
    return (
      <div className="auth-shell">
        <p className="empty">Loading…</p>
      </div>
    );
  }
  if (authState === 'needs-setup') {
    return <SetupPage onAuthenticated={refreshAuth} />;
  }
  if (authState === 'needs-login') {
    return (
      <LoginPage
        onAuthenticated={refreshAuth}
        signupEnabled={signupEnabled}
        supportUrl={supportUrl}
      />
    );
  }
  if (authState === 'authenticated-super') {
    return <SuperAdminApp onSignedOut={refreshAuth} supportUrl={supportUrl} />;
  }
  return <AuthenticatedApp onSignedOut={refreshAuth} supportUrl={supportUrl} />;
}

function SuperAdminApp({
  onSignedOut,
  supportUrl,
}: {
  onSignedOut: () => void;
  supportUrl: string | null;
}) {
  const { open, setOpen } = useMobileDrawer();
  async function logout() {
    try {
      await api.authLogout();
    } catch {
      /* logout is idempotent */
    }
    onSignedOut();
  }
  return (
    <div className="app">
      <MobileBar open={open} onToggle={() => setOpen(!open)} label="SmrtCash · super" />
      <aside className="sidebar">
        <div className="brand">
          Smrt<span>Cash</span>
        </div>
        <div className="muted" style={{ padding: '0 16px 8px', fontSize: 12 }}>
          Super admin console
        </div>
        <nav className="nav">
          <NavLink to="/system" end>
            Overview
          </NavLink>
          <NavLink to="/system/subscriptions">Subscriptions</NavLink>
          <NavLink to="/system/audit">Audit log</NavLink>
          <NavLink to="/health">Health</NavLink>
          <NavLink to="/backups">Backups</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-footer">
          <ThemeToggle />
          Platform operator
          <SupportLink supportUrl={supportUrl} />
          <button
            className="btn secondary logout-btn"
            type="button"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<SystemPage tab="overview" />} />
          <Route path="/system" element={<SystemPage tab="overview" />} />
          <Route
            path="/system/subscriptions"
            element={<SystemPage tab="subscriptions" />}
          />
          <Route path="/system/audit" element={<SystemPage tab="audit" />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/backups" element={<BackupsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <SidebarBackdrop open={open} onClose={() => setOpen(false)} />
      <InstallPrompt />
      <OfflineIndicator />
    </div>
  );
}

function AuthenticatedApp({
  onSignedOut,
  supportUrl,
}: {
  onSignedOut: () => void;
  supportUrl: string | null;
}) {
  const { open, setOpen } = useMobileDrawer();
  async function logout() {
    try {
      await api.authLogout();
    } catch {
      /* logout is idempotent — fall through to the state refresh */
    }
    onSignedOut();
  }

  return (
    <div className="app">
      <MobileBar open={open} onToggle={() => setOpen(!open)} />
      <aside className="sidebar">
        <div className="brand">
          Smrt<span>Cash</span>
        </div>
        <nav className="nav">
          <div className="nav-group">
            <div className="nav-group-label">Overview</div>
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/calendar">Calendar</NavLink>
            <NavLink to="/assistant">Assistant</NavLink>
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Money</div>
            <NavLink to="/accounts">Accounts</NavLink>
            <NavLink to="/transactions">Transactions</NavLink>
            <NavLink to="/uncategorized">Uncategorized</NavLink>
            <NavLink to="/transfers">Transfers</NavLink>
            <NavLink to="/categories">Categories</NavLink>
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Planning</div>
            <NavLink to="/budgets">Budgets</NavLink>
            <NavLink to="/goals">Goals</NavLink>
            <NavLink to="/bills">Bills</NavLink>
            <NavLink to="/subscriptions">Subscriptions</NavLink>
            <NavLink to="/retirement">Retirement</NavLink>
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Insights</div>
            <NavLink to="/reports">Reports</NavLink>
            <NavLink to="/tax">Tax</NavLink>
            <NavLink to="/anomalies">Anomalies</NavLink>
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Tools</div>
            <NavLink to="/import">Import</NavLink>
            <NavLink to="/connections">Connections</NavLink>
            <NavLink to="/vehicles">Vehicles</NavLink>
            <NavLink to="/routes">Routes</NavLink>
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Household</div>
            <NavLink to="/sharing">Sharing</NavLink>
            <NavLink to="/workspace">Workspace</NavLink>
            <NavLink to="/billing">Billing</NavLink>
          </div>
        </nav>
        <div className="sidebar-footer">
          <ThemeToggle />
          SmrtCash · v0.17.1
          <SupportLink supportUrl={supportUrl} />
          <button
            className="btn secondary logout-btn"
            type="button"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <TrialBanner />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/uncategorized" element={<UncategorizedPage />} />
          <Route path="/transfers" element={<TransfersPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/retirement" element={<RetirementPage />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/subscriptions" element={<SubscriptionsPage />} />
          <Route path="/vehicles" element={<VehiclesPage />} />
          <Route path="/routes" element={<RoutesPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/sharing" element={<SharingPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/tax" element={<TaxYearPage />} />
          <Route path="/anomalies" element={<AnomaliesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/billing" element={<BillingPage />} />
        </Routes>
      </main>
      <SidebarBackdrop open={open} onClose={() => setOpen(false)} />
      <InstallPrompt />
      <OfflineIndicator />
    </div>
  );
}

/**
 * 0.16.3 — small footer block linking out to the operator-
 * configured support / feature-request URL. Renders nothing
 * when the operator has cleared SUPPORT_URL. The "Feature
 * requests welcome too" copy on the unauthenticated pages is
 * deliberate: most help portals are perceived as bug-only
 * channels, so we spell out that we want the wishlist input
 * as well.
 */
function SupportLink({ supportUrl }: { supportUrl: string | null }) {
  if (!supportUrl) return null;
  return (
    <div className="muted small" style={{ marginTop: 6 }}>
      <a href={supportUrl} target="_blank" rel="noreferrer">
        Help & feature requests
      </a>
    </div>
  );
}
