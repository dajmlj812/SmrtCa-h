import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Phase 9.0 — mobile-only top bar with a hamburger toggle.
 *
 * The bar is hidden on desktop via CSS (only shows at <=768px). The
 * toggle drives a `data-open` attribute on the sidebar element so
 * the existing CSS slide-out works. Drawer auto-closes on every
 * route change.
 */
export function useMobileDrawer(sidebarSelector = '.sidebar') {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // Auto-close on navigation so tapping a nav link doesn't leave
  // the drawer covering the page the user is now on.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Mirror the React state onto a DOM data-attr the CSS reads. We
  // can't bind it through React on .sidebar without re-architecting
  // the parent, so this is the simplest cross-shell wiring.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(sidebarSelector);
    if (!el) return;
    if (open) el.setAttribute('data-open', 'true');
    else el.removeAttribute('data-open');
    return () => el.removeAttribute('data-open');
  }, [open, sidebarSelector]);

  // Close on Escape — keyboard accessibility.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return { open, setOpen };
}

export function MobileBar({
  open,
  onToggle,
  label = 'SmrtCash',
}: {
  open: boolean;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <div className="mobile-bar">
      <button
        className="hamburger"
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? '✕' : '☰'}
      </button>
      <div className="brand">{label}</div>
      <div className="mobile-bar-spacer" />
    </div>
  );
}

export function SidebarBackdrop({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="sidebar-backdrop"
      style={{ display: 'block' }}
      onClick={onClose}
      aria-hidden="true"
    />
  );
}
