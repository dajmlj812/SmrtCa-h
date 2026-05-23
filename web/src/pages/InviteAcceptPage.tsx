import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';

const MIN_PASSWORD = 8;

/**
 * /invite/:token — public landing page for an invitation link.
 *
 * Validates the token via GET /api/invitations/:token, then collects
 * email + name + password and posts the accept. On success the server
 * creates the user + membership and sets the session cookie; we then
 * route to the dashboard.
 */

interface Invitation {
  id: string;
  tenant_id: string;
  tenant_name: string;
  email_hint: string | null;
  role: 'admin' | 'member' | 'viewer';
  expires_at: string;
}

export function InviteAcceptPage() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadErr('Missing invitation token');
      return;
    }
    api
      .fetchInvitation(token)
      .then((r) => {
        setInvitation(r.invitation);
        if (r.invitation.email_hint) setEmail(r.invitation.email_hint);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : 'Invalid invite'));
  }, [token]);

  const tooShort = password !== '' && password.length < MIN_PASSWORD;
  const mismatch = confirm !== '' && password !== confirm;
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
      await api.acceptInvitation(token, {
        email: email.trim(),
        name: name.trim() || undefined,
        password,
      });
      navigate('/');
      // Force a reload so the App reruns auth probe and renders the app.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadErr) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand auth-brand">
            Smrt<span>Cash</span>
          </div>
          <h1>Invitation problem</h1>
          <p className="banner error">{loadErr}</p>
          <p className="muted">Ask whoever sent the link for a fresh one.</p>
        </div>
      </div>
    );
  }
  if (!invitation) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <p className="empty">Loading invitation…</p>
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
        <h1>You're invited</h1>
        <p className="muted">
          Join <strong>{invitation.tenant_name}</strong> as a{' '}
          <strong>{invitation.role}</strong>.
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
        <button className="btn auth-submit" type="submit" disabled={!ready || submitting}>
          {submitting ? 'Joining…' : 'Accept invitation'}
        </button>
      </form>
    </div>
  );
}
