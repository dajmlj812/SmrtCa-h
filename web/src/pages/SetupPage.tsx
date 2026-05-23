import { useState, type FormEvent } from 'react';
import { api } from '../api';

interface Props {
  /** Called after a successful setup so the App re-checks status. */
  onAuthenticated: () => void;
}

const MIN_PASSWORD = 8;

export function SetupPage({ onAuthenticated }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm !== '' && password !== confirm;
  const tooShort = password !== '' && password.length < MIN_PASSWORD;
  const ready = password.length >= MIN_PASSWORD && password === confirm;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.authSetup(password);
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
        <h1>Set your password</h1>
        <p className="muted">
          This is a single-user instance — pick a strong password (≥ 8
          characters). There's no recovery, so store it in a password
          manager.
        </p>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
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
