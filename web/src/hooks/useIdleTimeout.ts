import { useEffect, useRef } from 'react';

/**
 * 0.18.3 — auto-logout after N minutes of browser inactivity.
 *
 * "Activity" = any mouse/key/scroll/touch event on the window or
 * a `visibilitychange` flip back to visible. The timer resets on
 * every such event. When the timer fires, `onTimeout` is invoked
 * — App.tsx wires it to the same `logout()` call as the manual
 * Sign-out button.
 *
 * `minutes <= 0` disables the timer entirely (the operator-set
 * `WEB_INACTIVITY_TIMEOUT_MINUTES` defaults to 0). We avoid
 * subscribing to events at all in that case so disabled mode
 * has zero runtime overhead.
 *
 * Cross-tab note: we intentionally do NOT coordinate idle state
 * across tabs. If a user has two tabs open, activity in one is
 * activity for that tab only. Both tabs would log out roughly
 * together on shared inactivity; if one stays active the other
 * still logs out. That's the expected security model — if you
 * walked away from a tab, it gets locked.
 */
export function useIdleTimeout(
  minutes: number,
  onTimeout: () => void,
): void {
  // Stash the callback in a ref so the effect doesn't re-subscribe
  // every time the parent re-renders with a new closure identity.
  const cbRef = useRef(onTimeout);
  useEffect(() => {
    cbRef.current = onTimeout;
  }, [onTimeout]);

  useEffect(() => {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const ms = minutes * 60_000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reset = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), ms);
    };

    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'wheel',
      'touchstart',
      'scroll',
    ];
    for (const ev of events) {
      window.addEventListener(ev, reset, { passive: true });
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reset();
    };
    document.addEventListener('visibilitychange', onVisibility);

    reset();

    return () => {
      if (timer !== null) clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, reset);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [minutes]);
}
