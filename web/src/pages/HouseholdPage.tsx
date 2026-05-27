import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api,
  type Account,
  type AccountSplit,
  type CustodyPeriod,
  type HouseholdParticipant,
  type ParticipantKind,
} from '../api';
import { formatCents } from '../format';

/**
 * 0.21.3 — non-traditional household model page.
 *
 * Three sections:
 *   1. Participants — named people in the household (spouses, kids,
 *      co-parents, roommates) used for splits and custody.
 *   2. Per-account splits — assign account ownership across
 *      participants by percentage.
 *   3. Custody periods — date-ranged ownership for shared expenses
 *      that change hands over time (co-parents alternating weeks).
 *
 * Bottom section: per-participant year-to-date spend rollup so the
 * effect of the rules above is visible at a glance.
 */

const KIND_LABELS: Record<ParticipantKind, string> = {
  spouse: 'Spouse',
  child: 'Child',
  co_parent: 'Co-parent',
  roommate: 'Roommate',
  dependent: 'Dependent',
  other: 'Other',
};

export function HouseholdPage() {
  const [participants, setParticipants] = useState<HouseholdParticipant[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [splits, setSplits] = useState<AccountSplit[]>([]);
  const [custody, setCustody] = useState<CustodyPeriod[]>([]);
  const [totals, setTotals] = useState<{
    participant_id: string;
    participant_name: string;
    spend_cents: number;
    income_cents: number;
  }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showParticipantForm, setShowParticipantForm] = useState(false);
  const [editingParticipant, setEditingParticipant] = useState<HouseholdParticipant | null>(null);
  const [editingSplitsFor, setEditingSplitsFor] = useState<Account | null>(null);
  const [showCustodyForm, setShowCustodyForm] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [pRes, aRes, sRes, cRes, tRes] = await Promise.all([
        api.listParticipants(),
        api.listAccounts(),
        api.listSplits(),
        api.listCustodyPeriods(),
        api.participantTotals(),
      ]);
      setParticipants(pRes.participants);
      setAccounts(aRes);
      setSplits(sRes.splits);
      setCustody(cRes.custodyPeriods);
      setTotals(tRes.totals);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const splitsByAccount = useMemo(() => {
    const m = new Map<string, AccountSplit[]>();
    for (const s of splits) {
      const arr = m.get(s.account_id) ?? [];
      arr.push(s);
      m.set(s.account_id, arr);
    }
    return m;
  }, [splits]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Household</h1>
          <div className="subtitle">
            Define who's in your household and how shared accounts split
            between them. Custody periods override the percentage split
            for date ranges where a single participant owns the account.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && participants.length === 0 && <p className="empty">Loading…</p>}

      <section style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2>Participants</h2>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setEditingParticipant(null);
              setShowParticipantForm(true);
            }}
          >
            Add participant
          </button>
        </div>
        {participants.length === 0 ? (
          <p className="empty">
            No participants yet. Add one to start splitting accounts.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {participants.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.color && (
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block',
                            width: 12,
                            height: 12,
                            background: p.color,
                            borderRadius: 3,
                            marginLeft: 8,
                            verticalAlign: 'middle',
                          }}
                        />
                      )}
                    </td>
                    <td>{KIND_LABELS[p.kind]}</td>
                    <td>{p.email ?? '—'}</td>
                    <td>
                      <span className={`pill ${p.active ? 'pos' : ''}`}>
                        {p.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn-link"
                        type="button"
                        onClick={() => {
                          setEditingParticipant(p);
                          setShowParticipantForm(true);
                        }}
                      >
                        Edit
                      </button>
                      {' · '}
                      <button
                        className="btn-link"
                        type="button"
                        onClick={async () => {
                          if (!confirm(`Remove ${p.name}?`)) return;
                          await api.deleteParticipant(p.id);
                          void reload();
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Account splits</h2>
        {accounts.length === 0 ? (
          <p className="empty">No accounts to split.</p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Split</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const rows = splitsByAccount.get(a.id) ?? [];
                  return (
                    <tr key={a.id}>
                      <td><strong>{a.name}</strong></td>
                      <td>
                        {rows.length === 0 ? (
                          <span className="muted">No split (defaults to tenant)</span>
                        ) : (
                          rows
                            .map((r) => {
                              const p = participants.find((x) => x.id === r.participant_id);
                              return `${p?.name ?? '?'} ${r.split_pct}%`;
                            })
                            .join(' · ')
                        )}
                      </td>
                      <td>
                        <button
                          className="btn-link"
                          type="button"
                          onClick={() => setEditingSplitsFor(a)}
                          disabled={participants.length === 0}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2>Custody periods</h2>
          <button
            className="btn"
            type="button"
            disabled={participants.length === 0 || accounts.length === 0}
            onClick={() => setShowCustodyForm(true)}
          >
            Add custody period
          </button>
        </div>
        {custody.length === 0 ? (
          <p className="empty">
            No custody periods. Add one when a single participant owns
            an account for a specific date range.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Owner</th>
                  <th>Start</th>
                  <th>End</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {custody.map((c) => {
                  const a = accounts.find((x) => x.id === c.account_id);
                  const p = participants.find((x) => x.id === c.participant_id);
                  return (
                    <tr key={c.id}>
                      <td>{a?.name ?? '?'}</td>
                      <td>{p?.name ?? '?'}</td>
                      <td>{c.start_date}</td>
                      <td>{c.end_date ?? <span className="muted">— ongoing</span>}</td>
                      <td>
                        <button
                          className="btn-link"
                          type="button"
                          onClick={async () => {
                            if (!confirm('Delete this custody period?')) return;
                            await api.deleteCustodyPeriod(c.id);
                            void reload();
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>This year — per-participant rollup</h2>
        {totals.length === 0 ? (
          <p className="empty">
            No attributed totals yet. Add participants and splits or
            custody periods, then come back.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th className="num">Income</th>
                  <th className="num">Spend</th>
                  <th className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.participant_id}>
                    <td><strong>{t.participant_name}</strong></td>
                    <td className="num pos">{formatCents(t.income_cents)}</td>
                    <td className="num neg">−{formatCents(t.spend_cents)}</td>
                    <td className="num">
                      {formatCents(t.income_cents - t.spend_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showParticipantForm && (
        <ParticipantForm
          initial={editingParticipant}
          onClose={() => {
            setShowParticipantForm(false);
            setEditingParticipant(null);
          }}
          onSaved={() => {
            setShowParticipantForm(false);
            setEditingParticipant(null);
            void reload();
          }}
        />
      )}
      {editingSplitsFor && (
        <SplitsEditor
          account={editingSplitsFor}
          participants={participants}
          initial={splitsByAccount.get(editingSplitsFor.id) ?? []}
          onClose={() => setEditingSplitsFor(null)}
          onSaved={() => {
            setEditingSplitsFor(null);
            void reload();
          }}
        />
      )}
      {showCustodyForm && (
        <CustodyForm
          accounts={accounts}
          participants={participants}
          onClose={() => setShowCustodyForm(false)}
          onSaved={() => {
            setShowCustodyForm(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function ParticipantForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: HouseholdParticipant | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<ParticipantKind>(initial?.kind ?? 'other');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [color, setColor] = useState(initial?.color ?? '#4f46e5');
  const [active, setActive] = useState(initial?.active ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      if (!name.trim()) throw new Error('Name is required');
      const body = {
        name: name.trim(),
        kind,
        email: email.trim() || null,
        color: color || null,
        active,
      };
      if (initial) {
        await api.updateParticipant(initial.id, body);
      } else {
        await api.createParticipant(body);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={submit} style={{ maxWidth: 480 }}>
        <h2>{initial ? 'Edit participant' : 'New participant'}</h2>
        {err && <div className="banner error">{err}</div>}
        <div className="field">
          <label>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Kind</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as ParticipantKind)}>
            {Object.entries(KIND_LABELS).map(([k, lbl]) => (
              <option key={k} value={k}>{lbl}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Email (optional)</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Color (optional)</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        {initial && (
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />{' '}
              Active
            </label>
          </div>
        )}
        <div className="modal-footer">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SplitsEditor({
  account,
  participants,
  initial,
  onClose,
  onSaved,
}: {
  account: Account;
  participants: HouseholdParticipant[];
  initial: AccountSplit[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<Array<{ participantId: string; splitPct: string }>>(() =>
    initial.length > 0
      ? initial.map((s) => ({
          participantId: s.participant_id,
          splitPct: String(s.split_pct),
        }))
      : participants.length > 0
        ? [{ participantId: participants[0]!.id, splitPct: '100' }]
        : [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sum = rows.reduce((a, r) => a + (Number(r.splitPct) || 0), 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const payload = rows
        .filter((r) => r.participantId && r.splitPct.trim())
        .map((r) => ({
          participantId: r.participantId,
          splitPct: Number(r.splitPct),
        }));
      if (payload.length > 0 && Math.abs(sum - 100) > 0.001) {
        throw new Error(`Percentages must sum to 100 (currently ${sum.toFixed(2)}%)`);
      }
      await api.putSplits(account.id, payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={submit} style={{ maxWidth: 520 }}>
        <h2>Split: {account.name}</h2>
        {err && <div className="banner error">{err}</div>}
        <p className="muted small">
          Percentages must sum to 100. Leave empty to clear all splits
          (the account reverts to a single owner).
        </p>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <select
              style={{ flex: 1 }}
              value={r.participantId}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...r, participantId: e.target.value };
                setRows(next);
              }}
            >
              {participants.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              style={{ width: 100 }}
              value={r.splitPct}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...r, splitPct: e.target.value };
                setRows(next);
              }}
            />
            <span>%</span>
            <button
              type="button"
              className="btn-link"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="btn secondary"
            onClick={() =>
              setRows([
                ...rows,
                { participantId: participants[0]?.id ?? '', splitPct: '' },
              ])
            }
            disabled={participants.length === 0}
          >
            + Add participant
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Sum: <strong>{sum.toFixed(2)}%</strong>
        </p>
        <div className="modal-footer">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save splits'}
          </button>
        </div>
      </form>
    </div>
  );
}

function CustodyForm({
  accounts,
  participants,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  participants: HouseholdParticipant[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [participantId, setParticipantId] = useState(participants[0]?.id ?? '');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      if (!accountId || !participantId) throw new Error('Account and participant are required');
      await api.createCustodyPeriod({
        accountId,
        participantId,
        startDate,
        endDate: endDate || null,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={submit} style={{ maxWidth: 480 }}>
        <h2>New custody period</h2>
        {err && <div className="banner error">{err}</div>}
        <div className="field">
          <label>Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Owner during this window</label>
          <select value={participantId} onChange={(e) => setParticipantId(e.target.value)} required>
            {participants.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Start date</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </div>
        <div className="field">
          <label>End date (blank = ongoing)</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="modal-footer">
          <button className="btn secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Create period'}
          </button>
        </div>
      </form>
    </div>
  );
}
