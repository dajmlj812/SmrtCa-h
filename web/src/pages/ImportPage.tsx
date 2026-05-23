import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type Account,
  type ImportFormat,
  type ImportPreview,
  type ImportResult,
} from '../api';
import { formatCents, formatDate } from '../format';

export function ImportPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [formats, setFormats] = useState<ImportFormat[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState('');
  const [formatId, setFormatId] = useState(''); // '' = auto-detect
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function refreshAccounts() {
    api.listAccounts().then(setAccounts).catch(() => undefined);
  }

  useEffect(() => {
    refreshAccounts();
    api.listFormats().then(setFormats).catch(() => undefined);
  }, []);

  async function runPreview(f: File, fmt: string) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await api.previewImport(f, fmt || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setResult(null);
    setPreview(null);
    if (f) void runPreview(f, formatId);
  }

  function onFormatChange(value: string) {
    setFormatId(value);
    if (file) void runPreview(file, value);
  }

  async function commit() {
    if (!file || !accountId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.commitImport(
        file,
        accountId,
        formatId || undefined,
      );
      setResult(res);
      setPreview(null);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      refreshAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const canCommit =
    !!file && !!accountId && !!preview && preview.parsedCount > 0 && !busy;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Import</h1>
          <div className="subtitle">
            Upload a CSV, Excel, OFX, QFX, or QIF statement from your bank
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {accounts.length === 0 ? (
        <div className="banner info">
          You need an account first. <Link to="/">Create an account</Link> to
          import into.
        </div>
      ) : (
        <div className="card row-gap">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="import-account">Import into account *</label>
              <select
                id="import-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">Select an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="import-format">File format</label>
              <select
                id="import-format"
                value={formatId}
                onChange={(e) => onFormatChange(e.target.value)}
              >
                <option value="">Auto-detect</option>
                {formats.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="dropzone">
            <label htmlFor="import-file" className="muted">
              Choose a .csv / .xlsx / .ofx / .qfx / .qif file to import
            </label>
            <input
              id="import-file"
              ref={fileInputRef}
              type="file"
              accept=".csv,.CSV,.xlsx,.xls,.txt,.ofx,.OFX,.qfx,.QFX,.qif,.QIF"
              onChange={onFileChange}
            />
          </div>
        </div>
      )}

      {busy && !result && <p className="empty">Working…</p>}

      {preview && <PreviewPanel preview={preview} />}

      {preview && preview.detectedFormatId && (
        <div style={{ marginTop: 16 }}>
          <button className="btn" disabled={!canCommit} onClick={commit}>
            {busy
              ? 'Importing…'
              : `Import ${preview.parsedCount} transaction${
                  preview.parsedCount === 1 ? '' : 's'
                }`}
          </button>
          {!accountId && (
            <span className="muted" style={{ marginLeft: 12 }}>
              Select an account above to enable import.
            </span>
          )}
        </div>
      )}

      {result && <ResultPanel result={result} />}
    </div>
  );
}

function PreviewPanel({ preview }: { preview: ImportPreview }) {
  if (!preview.detectedFormatId) {
    return (
      <div className="banner error" style={{ marginTop: 16 }}>
        Could not recognize this file's format. Detected columns:{' '}
        {preview.headers.join(', ') || '(none)'}.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      <div className="banner success">
        Detected format: <strong>{preview.detectedFormatName}</strong> — parsed{' '}
        {preview.parsedCount} of {preview.totalRows} rows
        {preview.errorCount > 0
          ? `, ${preview.errorCount} could not be read`
          : ''}
        .
      </div>
      <div className="section-title">
        Preview (first {preview.sample.length})
      </div>
      <div className="table-wrap">
        <table className="txn-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Category</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {preview.sample.map((t, i) => (
              <tr key={i}>
                <td className="nowrap">{formatDate(t.txnDate)}</td>
                <td className="desc">{t.rawDescription}</td>
                <td>
                  {t.sourceCategory ?? <span className="muted">—</span>}
                </td>
                <td className={`num ${t.amountCents < 0 ? 'neg' : 'pos'}`}>
                  {formatCents(t.amountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.errors.length > 0 && (
        <>
          <div className="section-title">Rows with problems</div>
          <div className="card">
            <ul style={{ paddingLeft: 18 }}>
              {preview.errors.map((er) => (
                <li key={er.rowNumber} className="muted">
                  Row {er.rowNumber}: {er.message}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function ResultPanel({ result }: { result: ImportResult }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div className="banner success">
        Import complete — {result.importedCount} added, {result.skippedCount}{' '}
        skipped as duplicates
        {result.errorCount > 0 ? `, ${result.errorCount} errors` : ''}.
      </div>
      <Link to="/transactions" className="btn secondary">
        View transactions
      </Link>
    </div>
  );
}
