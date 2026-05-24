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
import { ThemeToggle } from './components/ThemeToggle';
import { MobileBar, SidebarBackdrop, useMobileDrawer } from './components/MobileBar';
import { InstallPrompt, OfflineIndicator } from './components/InstallPrompt';

type AuthState =
  | 'loading'
  | 'needs-setup'
  | 'needs-login'
  | 'authenticated-tenant'
  | 'authenticated-super';

export function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const location = useLocation();
  // /invite/:token is a public landing — skip the auth gate entirely.
  const isInviteRoute = location.pathname.startsWith('/invite/');

  const refreshAuth = useCallback(async () => {
    try {
      const status = await api.authStatus();
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
    return <LoginPage onAuthenticated={refreshAuth} />;
  }
  if (authState === 'authenticated-super') {
    return <SuperAdminApp onSignedOut={refreshAuth} />;
  }
  return <AuthenticatedApp onSignedOut={refreshAuth} />;
}

function SuperAdminApp({ onSignedOut }: { onSignedOut: () => void }) {
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
          <NavLink to="/system/audit">Audit log</NavLink>
          <NavLink to="/health">Health</NavLink>
          <NavLink to="/backups">Backups</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-footer">
          <ThemeToggle />
          Platform operator
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

function AuthenticatedApp({ onSignedOut }: { onSignedOut: () => void }) {
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
          </div>
        </nav>
        <div className="sidebar-footer">
          <ThemeToggle />
          SmrtCash · v0.14.3
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
        </Routes>
      </main>
      <SidebarBackdrop open={open} onClose={() => setOpen(false)} />
      <InstallPrompt />
      <OfflineIndicator />
    </div>
  );
}
