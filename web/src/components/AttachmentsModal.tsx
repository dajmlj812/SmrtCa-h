import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Attachment, type Transaction } from '../api';
import { formatCents, formatDate } from '../format';

interface Props {
  transaction: Transaction;
  onClose: () => void;
  /** Called whenever the attachment count changes (so the list page can refresh badges). */
  onCountChange?: (count: number) => void;
}

const ACCEPTED_MIME = 'image/jpeg,image/png,image/webp,application/pdf';
const POLL_INTERVAL_MS = 2000;

export function AttachmentsModal({
  transaction,
  onClose,
  onCountChange,
}: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 0.18.13 — phase + bytes for the upload progress UI. `null` = idle.
  const [progress, setProgress] = useState<{
    phase: 'uploading' | 'processing';
    loaded: number;
    total: number;
    fileLabel: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  const load = useCallback(async (): Promise<Attachment[]> => {
    const list = await api.listAttachments(transaction.id);
    setAttachments(list);
    onCountChangeRef.current?.(list.length);
    return list;
  }, [transaction.id]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function refresh() {
      try {
        const list = await load();
        if (cancelled) return;
        setLoading(false);
        // Keep polling while any attachment is still being scanned.
        if (list.some((a) => a.ocr_status === 'pending')) {
          timer = window.setTimeout(refresh, POLL_INTERVAL_MS);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load attachments');
        setLoading(false);
      }
    }
    void refresh();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [load]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    const fileLabel =
      files.length === 1 ? files[0]!.name : `${files.length} files`;
    setProgress({ phase: 'uploading', loaded: 0, total: 0, fileLabel });
    try {
      // 0.18.13 — use the progress-aware uploader so the user sees
      // bytes-out while the receipt is in flight, and a "Processing…"
      // step while the server parses the upload + writes to disk.
      // After the response lands, the OCR poll (further down) drives
      // the "Scanning…" indicator on each new card.
      const { promise } = api.uploadAttachmentsWithProgress(
        transaction.id,
        files,
        (state) => {
          setProgress({ ...state, fileLabel });
        },
      );
      const result = await promise;
      if (result.errors && result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      setProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm('Delete this attachment?')) return;
    setError(null);
    try {
      await api.deleteAttachment(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const title = transaction.normalized_merchant ?? transaction.raw_description;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Attachments for ${title}`}
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>Receipts &amp; attachments</h2>
            <div className="modal-subtitle">
              {title} · {formatDate(transaction.txn_date)} ·{' '}
              <span
                className={`num ${
                  transaction.amount_cents < 0 ? 'neg' : 'pos'
                }`}
              >
                {formatCents(transaction.amount_cents)}
              </span>
            </div>
          </div>
          <button
            className="modal-close"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        {error && <div className="banner error">{error}</div>}

        <DropZone
          onFiles={handleFiles}
          disabled={uploading}
          inputRef={fileInputRef}
          cameraInputRef={cameraInputRef}
          progress={progress}
        />

        {loading ? (
          <p className="empty">Loading…</p>
        ) : attachments.length === 0 ? (
          <p className="empty">No attachments yet — drop a receipt above.</p>
        ) : (
          <div className="attachment-grid">
            {attachments.map((a) => (
              <AttachmentCard
                key={a.id}
                attachment={a}
                transaction={transaction}
                onDelete={() => void handleDelete(a.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DropZone({
  onFiles,
  disabled,
  inputRef,
  cameraInputRef,
  progress,
}: {
  onFiles: (files: File[]) => void;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  cameraInputRef: React.RefObject<HTMLInputElement | null>;
  progress: {
    phase: 'uploading' | 'processing';
    loaded: number;
    total: number;
    fileLabel: string;
  } | null;
}) {
  const [hover, setHover] = useState(false);

  function pickFiles() {
    inputRef.current?.click();
  }
  function pickCamera() {
    cameraInputRef.current?.click();
  }

  return (
    <div
      className={`attachment-dropzone ${hover ? 'hover' : ''} ${
        disabled ? 'disabled' : ''
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        if (disabled) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
      role="region"
      aria-label="Receipt upload"
    >
      {progress ? (
        <UploadProgress progress={progress} />
      ) : (
        <>
          <div className="attachment-dropzone-text">
            <strong>Drop receipts here</strong>
            <span className="muted">
              {' '}
              · JPEG / PNG / WEBP / PDF · 25 MB max
            </span>
          </div>
          <div className="attachment-dropzone-actions">
            <button
              type="button"
              className="btn small"
              onClick={pickFiles}
              disabled={disabled}
            >
              Choose file
            </button>
            {/* 0.18.13 — Camera-capture button. On phones/tablets that
                support it, the `capture="environment"` hint opens the
                rear camera. On desktops it falls back to a normal file
                picker, so the button is safe to show everywhere. */}
            <button
              type="button"
              className="btn small secondary"
              onClick={pickCamera}
              disabled={disabled}
              title="Use your phone camera to take a photo of the receipt"
            >
              📷 Take photo
            </button>
          </div>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_MIME}
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}

function UploadProgress({
  progress,
}: {
  progress: {
    phase: 'uploading' | 'processing';
    loaded: number;
    total: number;
    fileLabel: string;
  };
}) {
  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : 0;
  const isUploading = progress.phase === 'uploading';
  return (
    <div
      className="upload-progress"
      role="status"
      aria-live="polite"
      aria-label={isUploading ? `Uploading ${pct}%` : 'Processing upload'}
    >
      <div className="upload-progress-label">
        <strong>
          {isUploading ? `Uploading ${pct}%` : 'Processing upload…'}
        </strong>
        <span className="muted"> {progress.fileLabel}</span>
      </div>
      <div className="upload-progress-bar">
        <div
          className={`upload-progress-fill ${isUploading ? '' : 'indeterminate'}`}
          style={isUploading ? { width: `${pct}%` } : undefined}
        />
      </div>
      <div className="muted small">
        {isUploading
          ? `${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`
          : 'Server is saving the file and scheduling the receipt scan. Scan progress appears below once the upload lands.'}
      </div>
    </div>
  );
}

function AttachmentCard({
  attachment,
  transaction,
  onDelete,
}: {
  attachment: Attachment;
  transaction: Transaction;
  onDelete: () => void;
}) {
  const isImage = attachment.mime_type.startsWith('image/');
  const isPdf = attachment.mime_type === 'application/pdf';
  const previewUrl = api.attachmentPreviewUrl(attachment.id);
  const downloadUrl = api.attachmentDownloadUrl(attachment.id);

  return (
    <div className="attachment-card">
      <div className="attachment-preview">
        {isImage && (
          <a href={previewUrl} target="_blank" rel="noopener noreferrer">
            <img src={previewUrl} alt={attachment.filename} loading="lazy" />
          </a>
        )}
        {isPdf && (
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="attachment-pdf-icon"
            title="Open PDF"
          >
            <span style={{ fontSize: 48 }}>📄</span>
            <span className="muted" style={{ fontSize: 12 }}>
              PDF
            </span>
          </a>
        )}
      </div>
      <div className="attachment-body">
        <div className="attachment-filename" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="muted attachment-size">
          {formatBytes(attachment.byte_size)}
        </div>
        <OcrSummary attachment={attachment} transaction={transaction} />
        <div className="attachment-actions">
          <a
            className="btn secondary"
            href={downloadUrl}
            download={attachment.filename}
          >
            Download
          </a>
          <button className="btn danger" type="button" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function OcrSummary({
  attachment,
  transaction,
}: {
  attachment: Attachment;
  transaction: Transaction;
}) {
  if (attachment.ocr_status === 'pending') {
    return <OcrScanningProgress createdAt={attachment.created_at} />;
  }
  if (attachment.ocr_status === 'skipped') {
    return (
      <div className="ocr-summary muted">
        No OCR · set <code>AI_PROVIDER=claude</code> to enable
      </div>
    );
  }
  if (attachment.ocr_status === 'failed') {
    return (
      <div className="ocr-summary failed">
        ⚠ Scan failed
        {attachment.ocr_note && (
          <div className="muted ocr-note">{attachment.ocr_note}</div>
        )}
      </div>
    );
  }
  // Extracted
  const match = matchesTransaction(attachment, transaction);
  const haveAny =
    attachment.extracted_amount_cents != null ||
    attachment.extracted_date != null ||
    attachment.extracted_merchant != null;

  return (
    <div className="ocr-summary extracted">
      <div className="ocr-kv">
        <span className="ocr-label">Merchant</span>
        <span>{attachment.extracted_merchant ?? <em className="muted">unclear</em>}</span>
      </div>
      <div className="ocr-kv">
        <span className="ocr-label">Amount</span>
        <span>
          {attachment.extracted_amount_cents != null
            ? formatCents(attachment.extracted_amount_cents)
            : <em className="muted">unclear</em>}
        </span>
      </div>
      <div className="ocr-kv">
        <span className="ocr-label">Date</span>
        <span>
          {attachment.extracted_date ? (
            formatDate(attachment.extracted_date)
          ) : (
            <em className="muted">unclear</em>
          )}
        </span>
      </div>
      {haveAny &&
        (match.amount && match.date ? (
          <span className="pill match-yes">✓ Matches transaction</span>
        ) : (
          <span
            className="pill match-no"
            title={`Amount ${match.amount ? 'OK' : 'differs'} · Date ${
              match.date ? 'OK' : 'differs'
            }`}
          >
            ⚠ Differs from transaction
          </span>
        ))}
      {attachment.ocr_note && (
        <div className="muted ocr-note">{attachment.ocr_note}</div>
      )}
    </div>
  );
}

function matchesTransaction(
  attachment: Attachment,
  transaction: Transaction,
): { amount: boolean; date: boolean } {
  const txnAmount = Math.abs(transaction.amount_cents);
  const recAmount = attachment.extracted_amount_cents;
  const amountMatch =
    recAmount != null && Math.abs(txnAmount - recAmount) <= 50; // $0.50 tolerance

  let dateMatch = false;
  if (attachment.extracted_date && transaction.txn_date) {
    const recDate = new Date(`${attachment.extracted_date}T00:00:00Z`).getTime();
    const txnDate = new Date(`${transaction.txn_date}T00:00:00Z`).getTime();
    const diffDays = Math.abs(recDate - txnDate) / (1000 * 60 * 60 * 24);
    dateMatch = diffDays <= 3;
  }
  return { amount: amountMatch, date: dateMatch };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 0.18.13 — Live OCR progress UI.
 *
 * Replaces the static "Scanning receipt…" spinner with an elapsed
 * counter + asymptotic progress bar + phase hints. The Claude vision
 * API takes ~60-90 seconds for a typical receipt and there's no
 * granular phase signal from the API, so the bar is time-based: ramp
 * to 95% over the expected duration, then crawl toward 99%. The phase
 * hint text changes over time so the user always sees the UI doing
 * something.
 *
 * If scanning exceeds the slow threshold (3 minutes), the panel
 * surfaces a "taking longer than usual" message — the back-end
 * timeout will eventually mark the row 'failed' regardless, but
 * users shouldn't have to stare at a moving bar for 3+ minutes
 * without explanation.
 */
const OCR_EXPECTED_MS = 90_000;
const OCR_SLOW_MS = 180_000;
const OCR_TICK_MS = 500;

function OcrScanningProgress({ createdAt }: { createdAt: string }) {
  const startedAt = new Date(createdAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), OCR_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Clamp at zero — if the client clock is ahead of the server, the
  // first frame would otherwise show a negative elapsed.
  const elapsedMs = Math.max(0, now - startedAt);
  const elapsedSec = Math.floor(elapsedMs / 1000);

  // Asymptotic curve so the bar visibly moves but never claims to be
  // about to finish when we don't actually know.
  const pct =
    elapsedMs < OCR_EXPECTED_MS
      ? (elapsedMs / OCR_EXPECTED_MS) * 95
      : Math.min(99, 95 + (elapsedMs - OCR_EXPECTED_MS) / 30_000);

  const isSlow = elapsedMs >= OCR_SLOW_MS;

  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  const elapsedLabel =
    mm > 0 ? `${mm}:${ss.toString().padStart(2, '0')}` : `${ss}s`;

  return (
    <div className="ocr-summary pending">
      <div className="ocr-pending-header">
        <span className="spinner" aria-hidden />
        <span>
          <strong>Scanning receipt…</strong>{' '}
          <span className="muted">{elapsedLabel}</span>
        </span>
      </div>
      <div className="ocr-progress-bar" aria-hidden>
        <div className="ocr-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small ocr-progress-hint">
        {isSlow ? (
          <>
            Taking longer than usual — still working. You can keep this open or
            come back later; the scan keeps running in the background.
          </>
        ) : (
          phaseHint(elapsedMs)
        )}
      </div>
    </div>
  );
}

function phaseHint(elapsedMs: number): string {
  if (elapsedMs < 5_000) return 'Sending image to the AI…';
  if (elapsedMs < 20_000) return 'AI is reading the receipt…';
  if (elapsedMs < 50_000) return 'Extracting merchant, amount, and date…';
  if (elapsedMs < OCR_EXPECTED_MS) return 'Finalizing the scan…';
  return 'Still scanning — most receipts finish in about 90 seconds.';
}
