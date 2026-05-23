import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// Apply the stored theme BEFORE React mounts so there's no flash of
// light theme on a dark-mode user's reload. ThemeToggle reads/writes
// the same localStorage key.
try {
  const stored = localStorage.getItem('smrtcash:theme');
  if (stored === 'dark') document.documentElement.dataset.theme = 'dark';
} catch {
  /* private mode etc. */
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
