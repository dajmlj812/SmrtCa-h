import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';

/**
 * 0.16.2 — reset-password landing.
 *
 * /reset-password?token=... — collects a new password,
 * validates client-side (length match server policy), submits
 * to /api/auth/password-reset-confirm. Server invalidates every
 * other session for the user, so we do NOT auto-sign in here —
 * we send the user to /login to authenticate with their new
 * password fresh.
 */

const MIN_PASSWORD = 8;

interface Props {
  /** 0.16.3 — operator-configured support URL. */
  supportUrl?: string | null;
}

export function ResetPasswordPage({ supportUrl }: Props = {}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm !== '' && password !== confirm;
  const tooShort = password !== '' && password.length < MIN_PASSWORD;
  const ready =
    token !== '' &&
    password.length >= MIN_PASSWORD &&
    password === confirm;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.authPasswordResetConfirm({ token, password });
      setDone(true);
      // Bounce to login after a short pause so the user can read
      // the confirmation.
      setTimeout(() => navigate('/login', { replace: true }), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (token === '') {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand auth-brand">
            Smrt<span>Cash</span>
          </div>
          <h1>Missing token</h1>
          <p>This reset link is malformed.</p>
          <p>
            <Link to="/forgot-password">Request a fresh reset link</Link>
          </p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand auth-brand">
            Smrt<span>Cash</span>
          </div>
          <h1>Password updated</h1>
          <p>Redirecting you to sign in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand auth-brand">
          Smrt<span>Cash</span>
        </div>
        <h1>Set a new password</h1>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="password">New password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {tooShort && (
            <div className="hint warn">
              At least {MIN_PASSWORD} characters.
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="confirm">Confirm new password</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {mismatch && (
            <div className="hint warn">Passwords don't match.</div>
          )}
        </div>
        <button
          className="btn auth-submit"
          type="submit"
          disabled={submitting || !ready}
        >
          {submitting ? 'Updating…' : 'Update password'}
        </button>
        <p className="muted small" style={{ marginTop: 16 }}>
          <Link to="/login">← Back to sign in</Link>
        </p>
        {supportUrl && (
          <p className="muted small" style={{ marginTop: 4 }}>
            Trouble resetting?{' '}
            <a href={supportUrl} target="_blank" rel="noreferrer">
              Visit support
            </a>{' '}
            — feature requests welcome too.
          </p>
        )}
      </form>
    </div>
  );
}
