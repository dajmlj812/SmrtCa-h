import { NavLink, Route, Routes } from 'react-router-dom';
import { AccountsPage } from './pages/AccountsPage';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { ImportPage } from './pages/ImportPage';
import { CategoriesPage } from './pages/CategoriesPage';

export function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Smrt<span>Cash</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Accounts
          </NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          <NavLink to="/categories">Categories</NavLink>
          <NavLink to="/import">Import</NavLink>
        </nav>
        <div className="sidebar-footer">Phase 2 · AI Normalization</div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<AccountsPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/import" element={<ImportPage />} />
        </Routes>
      </main>
    </div>
  );
}
