import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type AuthProviderDescriptor } from '../api';
import { BrandTagline } from '../components/BrandTagline';

interface Props {
  /** Called after a successful login so the App re-checks status. */
  onAuthenticated: () => void;
  /** 0.16.0 — show the "Create account" link when the server allows signup. */
  signupEnabled?: boolean;
  /** 0.16.3 — server-configured support / feature-request URL. */
  supportUrl?: string | null;
}

export function LoginPage({ onAuthenticated, signupEnabled, supportUrl }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AuthProviderDescriptor[]>([]);

  useEffect(() => {
    api.authProviders().then(setProviders).catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.authLogin({ email: email.trim(), password });
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  // The Local provider drives the in-page form; redirect providers
  // (OIDC/SAML) become big buttons above the password fields.
  const ssoProviders = providers.filter(
    (p) => p.kind !== 'local' && p.enabled,
  );

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand auth-brand">
          Smrt<span>Cash</span>
        </div>
        <h1>Welcome back</h1>
        <p className="muted">Sign in to continue.</p>
        {error && <div className="banner error">{error}</div>}

        {ssoProviders.length > 0 && (
          <div className="sso-providers">
            {ssoProviders.map((p) => (
              <a
                key={p.id}
                className="btn secondary sso-btn"
                href={`/api/auth/oidc/${p.id.replace(/^oidc:/, '')}/begin?returnTo=${encodeURIComponent('/')}`}
              >
                Continue with {p.displayName}
              </a>
            ))}
            <div className="sso-divider">or</div>
          </div>
        )}

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
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button
          className="btn auth-submit"
          type="submit"
          disabled={submitting || email === '' || password === ''}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small" style={{ marginTop: 16 }}>
          <Link to="/forgot-password">Forgot password?</Link>
          {signupEnabled && (
            <>
              {' · '}
              New to SmrtCash? <Link to="/signup">Create an account</Link>
            </>
          )}
        </p>
        {supportUrl && (
          <p className="muted small" style={{ marginTop: 4 }}>
            Need help?{' '}
            <a href={supportUrl} target="_blank" rel="noreferrer">
              Visit support
            </a>{' '}
            — feature requests welcome too.
          </p>
        )}
      </form>
      <BrandTagline />
    </div>
  );
}
