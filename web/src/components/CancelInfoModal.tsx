import { useState, type FormEvent } from 'react';
import { api, type Bill } from '../api';

interface Props {
  bill: Bill;
  onClose: () => void;
  onSaved: (updated: Bill) => void;
}

/**
 * 0.18.1 — "How to cancel" modal for a single bill.
 *
 * Surfaces the four cancellation fields (URL, email template,
 * steps, notes), with a one-click "Auto-fill from library" that
 * pulls in defaults from the server-side cancellation-library
 * for known merchants. All four fields are editable so the user
 * can correct or extend the seeded copy.
 *
 * Copy-to-clipboard buttons on the URL and email template
 * because moving copy from a textarea is the friction we're
 * removing — the entire feature is a friction-removal play.
 */
export function CancelInfoModal({ bill, onClose, onSaved }: Props) {
  const [cancelUrl, setCancelUrl] = useState(bill.cancel_url ?? '');
  const [cancelEmailTemplate, setCancelEmailTemplate] = useState(
    bill.cancel_email_template ?? '',
  );
  const [cancelSteps, setCancelSteps] = useState(bill.cancel_steps ?? '');
  const [cancelNotes, setCancelNotes] = useState(bill.cancel_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function autofill() {
    setLookingUp(true);
    setError(null);
    setInfo(null);
    try {
      const r = await api.lookupCancellation(bill.name);
      if (!r.matched || r.entry === null) {
        setInfo(
          `No library entry for "${bill.name}". Fill in what you know — it'll save to this bill only.`,
        );
        return;
      }
      const e = r.entry;
      // Only fill blanks — don't clobber what the user already wrote.
      if (cancelUrl === '' && e.cancelUrl) setCancelUrl(e.cancelUrl);
      if (cancelEmailTemplate === '' && e.emailTemplate)
        setCancelEmailTemplate(e.emailTemplate);
      if (cancelSteps === '' && e.steps) setCancelSteps(e.steps);
      if (cancelNotes === '' && e.notes) setCancelNotes(e.notes);
      setInfo(`Auto-filled from library entry "${e.merchant}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setLookingUp(false);
    }
  }

  async function copy(text: string, label: string) {
    if (text.trim() === '') return;
    try {
      await navigator.clipboard.writeText(text);
      setInfo(`${label} copied to clipboard.`);
    } catch {
      setError('Clipboard copy failed (browser permission denied).');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateBill(bill.id, {
        cancelUrl: cancelUrl.trim() === '' ? null : cancelUrl,
        cancelEmailTemplate:
          cancelEmailTemplate.trim() === '' ? null : cancelEmailTemplate,
        cancelSteps: cancelSteps.trim() === '' ? null : cancelSteps,
        cancelNotes: cancelNotes.trim() === '' ? null : cancelNotes,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>How to cancel — {bill.name}</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          {info && <div className="banner">{info}</div>}

          <div className="cancel-modal-toolbar">
            <button
              type="button"
              className="btn secondary"
              disabled={lookingUp}
              onClick={() => void autofill()}
              title="Fill blank fields from the built-in cancellation library"
            >
              {lookingUp ? 'Looking up…' : 'Auto-fill from library'}
            </button>
            <span className="muted">
              Built-in entries for Netflix, Spotify, NYT, gyms, and ~25 more.
            </span>
          </div>

          <div className="field">
            <label htmlFor="cancel-url">Cancellation URL</label>
            <div className="input-with-action">
              <input
                id="cancel-url"
                type="url"
                value={cancelUrl}
                onChange={(e) => setCancelUrl(e.target.value)}
                placeholder="https://example.com/account/cancel"
              />
              {cancelUrl.trim() !== '' && (
                <>
                  <a
                    href={cancelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-link"
                  >
                    Open ↗
                  </a>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => void copy(cancelUrl, 'URL')}
                  >
                    Copy
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor="cancel-steps">Step-by-step</label>
            <textarea
              id="cancel-steps"
              rows={6}
              value={cancelSteps}
              onChange={(e) => setCancelSteps(e.target.value)}
              placeholder={
                '1. Sign in at example.com\n2. Account → Subscription\n3. Click "Cancel"\n4. Confirm.'
              }
            />
          </div>

          <div className="field">
            <label htmlFor="cancel-email">Email template</label>
            <textarea
              id="cancel-email"
              rows={8}
              value={cancelEmailTemplate}
              onChange={(e) => setCancelEmailTemplate(e.target.value)}
              placeholder="Subject: Cancel my subscription&#10;&#10;Please cancel my subscription effective immediately…"
            />
            {cancelEmailTemplate.trim() !== '' && (
              <button
                type="button"
                className="btn-link"
                onClick={() => void copy(cancelEmailTemplate, 'Email body')}
              >
                Copy email body
              </button>
            )}
          </div>

          <div className="field">
            <label htmlFor="cancel-notes">Notes / caveats</label>
            <textarea
              id="cancel-notes"
              rows={3}
              value={cancelNotes}
              onChange={(e) => setCancelNotes(e.target.value)}
              placeholder="e.g. Phone-only cancel, expect a retention call, 30-day notice required…"
            />
          </div>

          <footer className="modal-footer">
            <button type="button" className="btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
