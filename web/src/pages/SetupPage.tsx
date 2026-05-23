import { useState, type FormEvent } from 'react';
import { api } from '../api';

interface Props {
  /** Called after a successful setup so the App re-checks status. */
  onAuthenticated: () => void;
}

const MIN_PASSWORD = 8;

export function SetupPage({ onAuthenticated }: Props) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await api.authSetup({
        email: email.trim(),
        name: name.trim() || undefined,
        password,
      });
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand auth-brand">
          Smrt<span>Cash</span>
        </div>
        <h1>Create the platform operator</h1>
        <p className="muted">
          The first user on a fresh install becomes a <strong>super admin</strong>:
          they manage tenants, system settings, and the audit log. They
          can't see financial data — those live in tenants. Pick a strong
          password (≥ {MIN_PASSWORD} characters). There's no email
          recovery, so store it in a password manager.
        </p>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="name">
            Display name <span className="muted">(optional)</span>
          </label>
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
            minLength={MIN_PASSWORD}
          />
          {tooShort && (
            <div className="field-hint error">
              At least {MIN_PASSWORD} characters required.
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
            <div className="field-hint error">Passwords do not match.</div>
          )}
        </div>
        <button
          className="btn auth-submit"
          type="submit"
          disabled={!ready || submitting}
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
