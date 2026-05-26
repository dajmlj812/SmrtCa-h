import { useState, type FormEvent } from 'react';
import { api, type Bill } from '../api';

interface Props {
  bill: Bill;
  onClose: () => void;
  onSaved: (updated: Bill) => void;
}

/**
 * 0.19.1 — "How to negotiate this bill" modal for a single bill.
 *
 * Mirror of CancelInfoModal but for retention / dispute / rate-
 * review flows. Surfaces the four negotiate_* fields with auto-fill
 * from the negotiation-library (which covers internet providers,
 * cell carriers, electric/gas utilities, and major insurance
 * carriers). Same UX: copy-to-clipboard on URL + email body so
 * the friction is gone.
 *
 * Different from cancel: the canned library defaults to a
 * generic retention-style email if no library entry matches,
 * because the underlying ask ("can I pay less?") translates
 * across most provider types.
 */
export function NegotiateInfoModal({ bill, onClose, onSaved }: Props) {
  const [negotiateUrl, setNegotiateUrl] = useState(bill.negotiate_url ?? '');
  const [negotiateEmailTemplate, setNegotiateEmailTemplate] = useState(
    bill.negotiate_email_template ?? '',
  );
  const [negotiateSteps, setNegotiateSteps] = useState(bill.negotiate_steps ?? '');
  const [negotiateNotes, setNegotiateNotes] = useState(bill.negotiate_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function autofill() {
    setLookingUp(true);
    setError(null);
    setInfo(null);
    try {
      const r = await api.lookupNegotiation(bill.name);
      if (!r.matched || r.entry === null) {
        // No library entry — but we have a sensible retention-style
        // generic template that works for most provider categories.
        // Auto-fill the email blank with that.
        if (negotiateEmailTemplate === '') {
          setNegotiateEmailTemplate(r.generic_retention_email);
        }
        setInfo(
          `No library entry for "${bill.name}". Filled the email field with a generic retention template — edit to add your account details, then save.`,
        );
        return;
      }
      const e = r.entry;
      if (negotiateUrl === '' && e.negotiateUrl) setNegotiateUrl(e.negotiateUrl);
      if (negotiateEmailTemplate === '' && e.emailTemplate)
        setNegotiateEmailTemplate(e.emailTemplate);
      if (negotiateSteps === '' && e.steps) setNegotiateSteps(e.steps);
      if (negotiateNotes === '' && e.notes) setNegotiateNotes(e.notes);
      setInfo(`Auto-filled from library entry "${e.merchant}" (${e.category}).`);
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
        negotiateUrl: negotiateUrl.trim() === '' ? null : negotiateUrl,
        negotiateEmailTemplate:
          negotiateEmailTemplate.trim() === '' ? null : negotiateEmailTemplate,
        negotiateSteps: negotiateSteps.trim() === '' ? null : negotiateSteps,
        negotiateNotes: negotiateNotes.trim() === '' ? null : negotiateNotes,
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>How to negotiate — {bill.name}</h2>
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
              title="Fill blank fields from the built-in negotiation library"
            >
              {lookingUp ? 'Looking up…' : 'Auto-fill from library'}
            </button>
            <span className="muted">
              Covers Xfinity / Spectrum / AT&amp;T / Verizon / T-Mobile / Mint /
              Geico / Progressive / State Farm and more.
            </span>
          </div>

          <div className="field">
            <label htmlFor="negotiate-url">Provider URL (billing / contact)</label>
            <div className="input-with-action">
              <input
                id="negotiate-url"
                type="url"
                value={negotiateUrl}
                onChange={(e) => setNegotiateUrl(e.target.value)}
                placeholder="https://example.com/billing/contact"
              />
              {negotiateUrl.trim() !== '' && (
                <>
                  <a
                    href={negotiateUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-link"
                  >
                    Open ↗
                  </a>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => void copy(negotiateUrl, 'URL')}
                  >
                    Copy
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor="negotiate-steps">Step-by-step / phone script</label>
            <textarea
              id="negotiate-steps"
              rows={7}
              value={negotiateSteps}
              onChange={(e) => setNegotiateSteps(e.target.value)}
              placeholder={
                '1. Call 1-800-xxx-xxxx; say "cancel" at the prompt to route to retention.\n2. State you\'re comparing offers from a competitor.\n3. Ask: "What\'s the lowest rate you can offer to keep me?"\n4. Don\'t accept the first offer — ask "is that the best you can do?" once.'
              }
            />
          </div>

          <div className="field">
            <label htmlFor="negotiate-email">Email template</label>
            <textarea
              id="negotiate-email"
              rows={10}
              value={negotiateEmailTemplate}
              onChange={(e) => setNegotiateEmailTemplate(e.target.value)}
              placeholder="Subject: Account review — exploring lower-cost options&#10;&#10;Hello, I'd like to review my current plan…"
            />
            {negotiateEmailTemplate.trim() !== '' && (
              <button
                type="button"
                className="btn-link"
                onClick={() => void copy(negotiateEmailTemplate, 'Email body')}
              >
                Copy email body
              </button>
            )}
          </div>

          <div className="field">
            <label htmlFor="negotiate-notes">Notes / caveats</label>
            <textarea
              id="negotiate-notes"
              rows={3}
              value={negotiateNotes}
              onChange={(e) => setNegotiateNotes(e.target.value)}
              placeholder="e.g. Best time to call: weekday afternoons. Promo cycles annually. Retention has $20-40/mo authority."
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
