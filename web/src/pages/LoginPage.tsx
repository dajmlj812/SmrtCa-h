import { useState, type FormEvent } from 'react';
import { api } from '../api';

interface Props {
  /** Called after a successful login so the App re-checks status. */
  onAuthenticated: () => void;
}

export function LoginPage({ onAuthenticated }: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.authLogin(password);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
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
        <h1>Welcome back</h1>
        <p className="muted">Enter your password to continue.</p>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button
          className="btn auth-submit"
          type="submit"
          disabled={submitting || password === ''}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
