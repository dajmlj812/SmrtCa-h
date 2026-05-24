import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';

interface Props {
  /** Called once the user is signed in so App re-checks auth state. */
  onAuthenticated: () => void;
}

/**
 * 0.16.0 — email verification landing page.
 *
 * /verify-email?token=... — POSTs the token to the server, which
 * provisions the tenant + membership and sets the session cookie.
 * On success we call onAuthenticated() so the App re-evaluates
 * auth state and routes the user straight to /billing to pick a
 * plan.
 *
 * On failure we show the error message inline. Common reasons:
 *   - "Invalid verification token" (typo / wrong link)
 *   - "This verification link has already been used"
 *   - "This verification link has expired"
 * Each suggests the right recovery action; we don't try to
 * auto-resend.
 */

export function VerifyEmailPage({ onAuthenticated }: Props) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<'pending' | 'ok' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);
  // Strict mode runs effects twice in dev; without this guard the
  // second run consumes the (now-consumed) token and we show an
  // "already used" error on a perfectly successful verification.
  const consumed = useRef(false);

  useEffect(() => {
    if (token === '') {
      setStatus('error');
      setError('Missing verification token in the link.');
      return;
    }
    if (consumed.current) return;
    consumed.current = true;
    api
      .authVerifyEmail(token)
      .then(() => {
        setStatus('ok');
        // Re-evaluate auth state and land the user on /billing so
        // they can pick a plan.
        onAuthenticated();
        navigate('/billing', { replace: true });
      })
      .catch((err) => {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Verification failed');
      });
  }, [token, onAuthenticated, navigate]);

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand auth-brand">
          Smrt<span>Cash</span>
        </div>
        {status === 'pending' && (
          <>
            <h1>Confirming your email…</h1>
            <p className="muted">One moment.</p>
          </>
        )}
        {status === 'ok' && (
          <>
            <h1>You're in!</h1>
            <p>Redirecting to your billing page…</p>
          </>
        )}
        {status === 'error' && (
          <>
            <h1>Couldn't confirm</h1>
            <div className="banner error">{error}</div>
            <p className="muted">
              <Link to="/signup">Sign up again</Link> or{' '}
              <Link to="/login">return to sign in</Link>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
