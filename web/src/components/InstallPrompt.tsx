import { useEffect, useState } from 'react';

/**
 * Phase 9.0 — PWA install + offline affordances.
 *
 * Captures `beforeinstallprompt` (Chrome / Edge / Android). Hides
 * itself once the user dismisses (localStorage flag) or once the app
 * is launched in standalone mode. The flag intentionally has no
 * expiry — if the user dismisses, we stop pestering them.
 *
 * Also renders a small "Offline" pill whenever `navigator.onLine`
 * flips false. The service worker keeps the SPA usable on a dead
 * network for already-visited routes; this pill is just a heads-up.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISSED_KEY = 'smrtcash:install-dismissed';

export function InstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    function onPrompt(e: Event) {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setEvt(null);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!evt || dismissed) return null;
  // Hide if the user already launched the PWA — beforeinstallprompt
  // typically wouldn't fire in standalone mode, but belt-and-braces.
  if (window.matchMedia('(display-mode: standalone)').matches) return null;

  return (
    <div className="install-prompt" role="dialog" aria-label="Install SmrtCash">
      <span>Install SmrtCash to your home screen for quick access.</span>
      <div className="install-prompt-actions">
        <button
          className="btn small"
          onClick={() => {
            void evt.prompt().then(async () => {
              await evt.userChoice;
              setEvt(null);
            });
          }}
        >
          Install
        </button>
        <button
          className="btn small secondary"
          onClick={() => {
            try {
              localStorage.setItem(DISMISSED_KEY, 'true');
            } catch {
              /* ignore */
            }
            setDismissed(true);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

export function OfflineIndicator() {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  useEffect(() => {
    function up() {
      setOnline(true);
    }
    function down() {
      setOnline(false);
    }
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  if (online) return null;
  return (
    <div className="offline-pill" role="status" aria-live="polite">
      Offline
    </div>
  );
}
