import { useEffect, useState, type FormEvent } from 'react';
import { api, type SplitParticipant, type TransactionShare } from '../api';
import { formatCents } from '../format';

/**
 * Phase 9.2 — modal to assign per-participant shares to a transaction.
 *
 * Sign convention: shareCents matches the sign of the transaction
 * amount. For a -$100 dinner, each participant's share is negative
 * (-$25 etc.). The UI shows them as absolute dollar values to keep
 * the math intuitive; the API converts back on save.
 */

interface DraftShare {
  participantId: string;
  amountAbs: string; // user types positive dollars
}

interface Props {
  transactionId: string;
  transactionAmountCents: number;
  transactionDescription?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function SplitTransactionModal({
  transactionId,
  transactionAmountCents,
  transactionDescription,
  onClose,
  onSaved,
}: Props) {
  const [participants, setParticipants] = useState<SplitParticipant[]>([]);
  const [existing, setExisting] = useState<TransactionShare[]>([]);
  const [drafts, setDrafts] = useState<DraftShare[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sign = transactionAmountCents < 0 ? -1 : 1;
  const txnAbs = Math.abs(transactionAmountCents);

  async function refresh() {
    const [p, s] = await Promise.all([
      api.listSplitParticipants(),
      api.getTransactionShares(transactionId),
    ]);
    setParticipants(p);
    setExisting(s.shares);
    setDrafts(
      s.shares.map((sh) => ({
        participantId: sh.participant_id,
        amountAbs: (Math.abs(sh.share_cents) / 100).toFixed(2),
      })),
    );
  }
  useEffect(() => {
    void refresh();
  }, [transactionId]);

  function updateDraft(participantId: string, amountAbs: string) {
    setDrafts((cur) => {
      const others = cur.filter((d) => d.participantId !== participantId);
      if (amountAbs === '' || amountAbs === '0' || amountAbs === '0.00')
        return others;
      return [...others, { participantId, amountAbs }];
    });
  }

  async function addParticipant(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.createSplitParticipant({ name: newName.trim() });
      setNewName('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add participant');
    }
  }

  function splitEqually() {
    const people = participants.filter((p) => !p.archived);
    if (people.length === 0) return;
    // Include the tenant ("you") in the split.
    const partsTotal = people.length + 1;
    const perPart = Math.floor(txnAbs / partsTotal);
    setDrafts(
      people.map((p) => ({
        participantId: p.id,
        amountAbs: (perPart / 100).toFixed(2),
      })),
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const shares = drafts
        .map((d) => {
          const cents = Math.round(Number(d.amountAbs) * 100);
          if (!Number.isFinite(cents) || cents <= 0) return null;
          return { participantId: d.participantId, shareCents: sign * cents };
        })
        .filter((s): s is { participantId: string; shareCents: number } => s !== null);
      await api.putTransactionShares(transactionId, shares);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  const allocatedCents = drafts.reduce(
    (acc, d) => acc + Math.round(Number(d.amountAbs || '0') * 100),
    0,
  );
  const remainingCents = txnAbs - allocatedCents;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Split transaction</h2>
          <button
            className="btn small secondary"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="muted" style={{ marginBottom: 12 }}>
          {transactionDescription ? `${transactionDescription} · ` : ''}
          Total: <strong>{formatCents(transactionAmountCents)}</strong>
        </div>

        {error && <div className="banner error">{error}</div>}

        {participants.length === 0 ? (
          <p className="empty">
            No participants yet. Add one below — you can also use the Sharing
            page to manage them.
          </p>
        ) : (
          <table className="txn-table" style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Participant</th>
                <th className="num">Their share ($)</th>
              </tr>
            </thead>
            <tbody>
              {participants
                .filter((p) => !p.archived)
                .map((p) => {
                  const cur = drafts.find((d) => d.participantId === p.id);
                  return (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="num">
                        <input
                          inputMode="decimal"
                          style={{ width: 100, textAlign: 'right' }}
                          value={cur?.amountAbs ?? ''}
                          onChange={(e) => updateDraft(p.id, e.target.value)}
                          placeholder="0.00"
                        />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}

        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Allocated: <strong>{formatCents(sign * allocatedCents)}</strong> ·
          Remaining (your share): <strong>{formatCents(sign * remainingCents)}</strong>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            className="btn small secondary"
            type="button"
            onClick={splitEqually}
            disabled={participants.length === 0}
          >
            Split equally (incl. you)
          </button>
          <button className="btn" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : existing.length > 0 ? 'Update split' : 'Save split'}
          </button>
        </div>

        <form onSubmit={addParticipant} className="form-grid" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div className="field">
            <label>Add a participant</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
            />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn small" type="submit" disabled={!newName.trim()}>
              Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
