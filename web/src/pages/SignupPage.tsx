import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { BrandTagline } from '../components/BrandTagline';

/**
 * 0.16.0 — public signup page.
 *
 * Collects email + display name + password, hits /api/auth/signup,
 * shows a "check your email" confirmation. Account creation
 * completes only after the user clicks the verification link
 * (see VerifyEmailPage).
 *
 * The "Create account" link from /login routes here. When the
 * server has PUBLIC_SIGNUP_ENABLED=false this page is still
 * reachable but the signup call will 404; that's fine — the
 * signup link won't have been shown.
 */

const MIN_PASSWORD = 8;

interface Props {
  /** 0.16.3 — operator-configured support URL. */
  supportUrl?: string | null;
}

export function SignupPage({ supportUrl }: Props = {}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const mismatch = confirm !== '' && password !== confirm;
  const tooShort = password !== '' && password.length < MIN_PASSWORD;
  const ready =
    email.trim() !== '' &&
    password.length >= MIN_PASSWORD &&
    password === confirm;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.authSignup({
        email: email.trim(),
        name: name.trim() || undefined,
        password,
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
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
            We sent a verification link to <strong>{email.trim()}</strong>.
            Click it to finish creating your account.
          </p>
          <p className="muted small">
            The link expires in 24 hours. If you don't see the email, check
            your spam folder. If the email still doesn't arrive, sign up
            again with the same address — we'll re-send the link.
          </p>
          <p>
            <Link to="/login">← Back to sign in</Link>
          </p>
          <BrandTagline />
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
        <h1>Create your account</h1>
        <p className="muted">
          Start your 14-day free trial. No card required up front.
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
        <div className="field">
          <label htmlFor="name">Your name (optional)</label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
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
          <label htmlFor="confirm">Confirm password</label>
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
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
        <p className="muted small" style={{ marginTop: 16 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
        {supportUrl && (
          <p className="muted small" style={{ marginTop: 4 }}>
            Questions?{' '}
            <a href={supportUrl} target="_blank" rel="noreferrer">
              Visit support
            </a>{' '}
            — feature requests welcome too.
          </p>
        )}
        <p className="muted small auth-legal-links">
          By creating an account you agree to our{' '}
          <Link to="/terms">Terms</Link> and{' '}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
        <BrandTagline />
      </form>
    </div>
  );
}
