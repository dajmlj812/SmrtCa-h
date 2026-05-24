import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

/**
 * 0.16.2 — forgot-password landing page.
 *
 * Collects email, calls /api/auth/password-reset-request,
 * always shows the same "if it's a real address you'll get a
 * link" confirmation. The server returns 202 regardless so the
 * client can't enumerate accounts either; this page just
 * mirrors that behavior so the UX matches the security model.
 */

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.authPasswordResetRequest(email.trim());
      setSent(true);
    } catch (err) {
      // Server is supposed to 202 unconditionally; if we end up
      // here it's a network / 5xx. Don't reveal whether the email
      // was valid.
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand auth-brand">
            Smrt<span>Cash</span>
          </div>
          <h1>Check your email</h1>
          <p>
            If <strong>{email.trim()}</strong> matches an account, we sent a
            password reset link to it. The link expires in 1 hour.
          </p>
          <p className="muted small">
            Didn't get the email? Check your spam folder, or wait a minute and
            try again — duplicate requests don't invalidate previous links.
          </p>
          <p>
            <Link to="/login">← Back to sign in</Link>
          </p>
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
        <h1>Reset your password</h1>
        <p className="muted">
          Enter your email and we'll send you a link to set a new password.
        </p>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <button
          className="btn auth-submit"
          type="submit"
          disabled={submitting || email.trim() === ''}
        >
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
        <p className="muted small" style={{ marginTop: 16 }}>
          <Link to="/login">← Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
