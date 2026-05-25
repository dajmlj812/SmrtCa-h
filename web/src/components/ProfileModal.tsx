import { useMemo, useState, type FormEvent } from 'react';
import { api, type MeResponse } from '../api';
import { ApiKeysSection } from './ApiKeysSection';

interface Props {
  me: MeResponse;
  onClose: () => void;
  onSaved: (updated: {
    name: string | null;
    timezone: string | null;
  }) => void;
}

// Curated short list of common zones surfaced at the top of the
// dropdown. The user can still pick anything in
// `Intl.supportedValuesOf('timeZone')` via the full list below.
const POPULAR_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

function detectBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function listAllZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return POPULAR_ZONES;
  }
}

/**
 * 0.18.3 — small "My profile" modal: edit display name + IANA
 * timezone. Timezone NULL means "follow my browser" — the dropdown
 * shows that as the first option with the detected zone in parens.
 */
export function ProfileModal({ me, onClose, onSaved }: Props) {
  const [name, setName] = useState(me.user.name ?? '');
  const [timezone, setTimezone] = useState<string>(me.user.timezone ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browserTz = useMemo(detectBrowserTz, []);
  const allZones = useMemo(listAllZones, []);
  const popular = POPULAR_ZONES.filter((z) => allZones.includes(z));
  const remaining = allZones.filter((z) => !POPULAR_ZONES.includes(z));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const tz = timezone.trim() === '' ? null : timezone;
      const r = await api.updateMyProfile({
        name: trimmedName === '' ? null : trimmedName,
        timezone: tz,
      });
      onSaved({ name: r.user.name, timezone: r.user.timezone });
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
          <h2>My profile</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}

          <div className="field">
            <label>Email</label>
            <div className="muted">{me.user.email ?? '(no email on file)'}</div>
          </div>

          <div className="field">
            <label htmlFor="profile-name">Display name</label>
            <input
              id="profile-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              placeholder="Your name"
            />
          </div>

          <div className="field">
            <label htmlFor="profile-tz">Timezone</label>
            <select
              id="profile-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              <option value="">Follow my browser ({browserTz})</option>
              <optgroup label="Common">
                {popular.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </optgroup>
              <optgroup label="All zones">
                {remaining.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </optgroup>
            </select>
            <div className="muted small">
              Times across the app display in this zone. Date-only fields
              (transaction dates, bill due dates) are unaffected.
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button type="button" className="btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>

        <hr style={{ margin: '24px 0', border: 0, borderTop: '1px solid var(--border, #d0d7de)' }} />

        <ApiKeysSection />
      </div>
    </div>
  );
}
