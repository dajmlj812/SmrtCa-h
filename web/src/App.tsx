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
import { ThemeToggle } from './components/ThemeToggle';

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
    </div>
  );
}

function AuthenticatedApp({ onSignedOut }: { onSignedOut: () => void }) {
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
      <aside className="sidebar">
        <div className="brand">
          Smrt<span>Cash</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/accounts">Accounts</NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          <NavLink to="/uncategorized">Uncategorized</NavLink>
          <NavLink to="/transfers">Transfers</NavLink>
          <NavLink to="/budgets">Budgets</NavLink>
          <NavLink to="/goals">Goals</NavLink>
          <NavLink to="/retirement">Retirement</NavLink>
          <NavLink to="/bills">Bills</NavLink>
          <NavLink to="/subscriptions">Subscriptions</NavLink>
          <NavLink to="/vehicles">Vehicles</NavLink>
          <NavLink to="/routes">Routes</NavLink>
          <NavLink to="/categories">Categories</NavLink>
          <NavLink to="/import">Import</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <NavLink to="/workspace">Workspace</NavLink>
        </nav>
        <div className="sidebar-footer">
          <ThemeToggle />
          SmrtCash · v0.9.5
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
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/workspace" element={<WorkspacePage />} />
        </Routes>
      </main>
    </div>
  );
}
