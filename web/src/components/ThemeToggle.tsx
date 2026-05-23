import { useEffect, useState } from 'react';

/**
 * Light / Dark theme picker. Persists choice to localStorage and sets
 * `data-theme="dark"` on the document element so the token overrides
 * in styles.css kick in.
 *
 * The initial value is read from the DOM (set by main.tsx before
 * React mounts) so this component never causes a flash.
 */

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'smrtcash:theme';

function readCurrentTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(t: Theme): void {
  if (typeof document === 'undefined') return;
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* ignore storage errors */
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readCurrentTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button
        type="button"
        className={theme === 'light' ? 'active' : ''}
        onClick={() => setTheme('light')}
        aria-pressed={theme === 'light'}
      >
        Light
      </button>
      <button
        type="button"
        className={theme === 'dark' ? 'active' : ''}
        onClick={() => setTheme('dark')}
        aria-pressed={theme === 'dark'}
      >
        Dark
      </button>
    </div>
  );
}
