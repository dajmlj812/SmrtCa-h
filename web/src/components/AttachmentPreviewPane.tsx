import { useEffect, useState } from 'react';
import { api, type Attachment } from '../api';
import { formatCents } from '../format';

/**
 * 0.18.13 — Attachment preview pane.
 *
 * Used inside the Splits modals so the user can see the receipt while
 * they're carving the transaction into category lines (SplitsModal) or
 * household shares (SplitTransactionModal). Two display modes:
 *
 *   • inline preview: image directly rendered, PDF embedded via
 *     <object>. Tabs across the bottom switch between multiple files.
 *
 *   • pop-out: opens a small browser window the user can drag next to
 *     the split editor. The window survives modal close, so they can
 *     reference the receipt even after the modal goes away if they
 *     want to compare with a transaction list etc.
 *
 * If the transaction has no attachments, the pane returns null —
 * callers don't have to gate the render themselves.
 */

interface Props {
  transactionId: string;
  /** Caller controls overall layout; the pane fills the space given. */
  className?: string;
}

export function AttachmentPreviewPane({ transactionId, className }: Props) {
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listAttachments(transactionId);
        if (cancelled) return;
        setAttachments(list);
        if (list.length > 0) setActiveId(list[0]!.id);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load attachments');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  if (error) {
    return <div className="banner error">{error}</div>;
  }
  if (attachments === null) {
    return <div className={className ?? ''}><p className="empty">Loading attachment…</p></div>;
  }
  if (attachments.length === 0) {
    // Caller probably gated on this already — emit nothing so we don't
    // leave a blank pane in the layout.
    return null;
  }

  const active = attachments.find((a) => a.id === activeId) ?? attachments[0]!;
  const isImage = active.mime_type.startsWith('image/');
  const isPdf = active.mime_type === 'application/pdf';
  const previewUrl = api.attachmentPreviewUrl(active.id);

  function openPopout() {
    // A right-side popout that comfortably fits a receipt — most
    // phones photograph in portrait so we open taller than wide.
    // The user is free to resize and move it; the browser respects
    // the initial dimensions on first open.
    const w = Math.min(720, Math.max(420, Math.round(window.innerWidth * 0.4)));
    const h = Math.min(960, Math.max(600, Math.round(window.innerHeight * 0.85)));
    // `noopener` keeps the popped-out window from being able to script
    // back into the opener. The trade-off: we can't refer to the
    // returned reference (it'd be null). That's fine — the user closes
    // the popout themselves.
    window.open(
      previewUrl,
      `smrtcash-receipt-${active.id}`,
      `popup=yes,width=${w},height=${h},noopener,noreferrer`,
    );
  }

  return (
    <div className={`attachment-preview-pane ${className ?? ''}`}>
      <div className="attachment-preview-header">
        <div className="attachment-preview-title" title={active.filename}>
          📎 {active.filename}
        </div>
        <button
          type="button"
          className="btn small secondary"
          onClick={openPopout}
          title="Open in a new window so it stays visible while you scroll"
        >
          ⧉ Pop out
        </button>
      </div>

      <div className="attachment-preview-body">
        {isImage && (
          <img
            src={previewUrl}
            alt={active.filename}
            className="attachment-preview-image"
          />
        )}
        {isPdf && (
          <object
            data={previewUrl}
            type="application/pdf"
            className="attachment-preview-pdf"
            aria-label={active.filename}
          >
            <p className="muted">
              PDF preview not supported here.{' '}
              <a href={previewUrl} target="_blank" rel="noreferrer">
                Open in new tab
              </a>
            </p>
          </object>
        )}
        {!isImage && !isPdf && (
          <p className="muted">
            {active.mime_type} — preview not supported.{' '}
            <a href={previewUrl} target="_blank" rel="noreferrer">
              Open
            </a>
          </p>
        )}
      </div>

      {attachments.length > 1 && (
        <div className="attachment-preview-tabs" role="tablist">
          {attachments.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={a.id === active.id}
              className={`attachment-preview-tab ${a.id === active.id ? 'active' : ''}`}
              onClick={() => setActiveId(a.id)}
              title={a.filename}
            >
              {a.mime_type === 'application/pdf' ? '📄' : '🖼'} {i + 1}
            </button>
          ))}
        </div>
      )}

      {(active.extracted_amount_cents != null ||
        active.extracted_merchant != null ||
        active.extracted_date != null) && (
        <div className="attachment-preview-ocr muted small">
          {active.extracted_merchant && (
            <span>Merchant: <strong>{active.extracted_merchant}</strong></span>
          )}
          {active.extracted_amount_cents != null && (
            <span>
              {' · '}
              Amount:{' '}
              <strong>{formatCents(active.extracted_amount_cents)}</strong>
            </span>
          )}
          {active.extracted_date && (
            <span>
              {' · '}
              Date: <strong>{active.extracted_date}</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
