import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
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

type AuthState = 'loading' | 'needs-setup' | 'needs-login' | 'authenticated';

export function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');

  const refreshAuth = useCallback(async () => {
    try {
      const status = await api.authStatus();
      if (!status.isSetup) setAuthState('needs-setup');
      else if (!status.authenticated) setAuthState('needs-login');
      else setAuthState('authenticated');
    } catch {
      // Network-down or server-down — show the login screen so the user
      // can retry. Avoids a permanent blank app if /status briefly fails.
      setAuthState('needs-login');
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

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

  return <AuthenticatedApp onSignedOut={refreshAuth} />;
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
          <NavLink to="/transfers">Transfers</NavLink>
          <NavLink to="/budgets">Budgets</NavLink>
          <NavLink to="/goals">Goals</NavLink>
          <NavLink to="/bills">Bills</NavLink>
          <NavLink to="/categories">Categories</NavLink>
          <NavLink to="/import">Import</NavLink>
        </nav>
        <div className="sidebar-footer">
          Phase 6 · Budgeting
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
          <Route path="/transfers" element={<TransfersPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/import" element={<ImportPage />} />
        </Routes>
      </main>
    </div>
  );
}
