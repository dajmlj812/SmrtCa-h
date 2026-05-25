import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type AiModelOption, type AppSetting } from '../api';

/**
 * 0.18.13 — Settings console redesign.
 *
 * Design direction: this is an operator console, not a marketing page.
 * The audience is sysadmins who already know what the keys do — they
 * need to find a key fast, see its state at a glance, and edit it
 * without losing their place in the list. The aesthetic is dense,
 * monospace-leaning, color-coded by state.
 *
 * Layout:
 *   • Page header carries the global summary (total keys / staged
 *     restarts) and the Restart button.
 *   • Top toolbar: search input + filter chips.
 *   • Recently-changed strip (last 5 rows with updated_at populated)
 *     so "what did I change yesterday?" answers itself.
 *   • Two-column body on desktop: sticky left section nav with per-
 *     section counts + restart-required badge, scrolling content
 *     pane on the right. Section anchors let the nav jump-to.
 *   • Each row carries explicit status chips driven by the existing
 *     AppSetting flags (configured_in_gui, env_fallback_present,
 *     restart_required, is_secret). The chips are color-coded so a
 *     glance tells you whether saving will take effect now or
 *     requires a restart.
 *   • Inline confirmation on save: row flashes green for 2s and
 *     shows a "saved" chip near the value — no top-of-page banner.
 *
 * What I preserved verbatim:
 *   • The SECTIONS array (order, grouping)
 *   • Per-key special editors (AI_PROVIDER, ANTHROPIC_MODEL,
 *     OLLAMA_MODEL, the EIA help link, URL hints, destructive
 *     confirms for SESSION_SECRET + ATTACHMENT_ENCRYPTION_KEY)
 *   • The SmtpTestPanel rendered inside the SMTP section
 *   • The server contract — no API changes
 */

const AI_PROVIDERS = ['none', 'rules', 'claude', 'ollama'];

const URL_TYPED_KEYS = new Set<string>([
  'PUBLIC_BASE_URL',
  'SUPPORT_URL',
  'OLLAMA_BASE_URL',
]);

function checkUrlHint(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return 'This doesn’t look like a valid URL (e.g. https://example.com).';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `URL must start with http:// or https:// (got "${parsed.protocol}").`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'There’s an "@" before the host — that’s almost always a typo of "." in a hostname.';
  }
  return null;
}

interface SectionDef {
  /** Stable slug used as the anchor + nav id. */
  slug: string;
  title: string;
  subtitle: string;
  keys: string[];
}

const SECTIONS: SectionDef[] = [
  {
    slug: 'ai',
    title: 'AI Provider',
    subtitle:
      'Drives transaction normalization and receipt OCR. Changes take effect on the next AI call.',
    keys: [
      'AI_PROVIDER',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'OLLAMA_BASE_URL',
      'OLLAMA_MODEL',
    ],
  },
  {
    slug: 'external-apis',
    title: 'External APIs',
    subtitle: 'Optional integrations. Leave blank to use manual entry only.',
    keys: ['EIA_API_KEY'],
  },
  {
    slug: 'smtp',
    title: 'SMTP — outbound email',
    subtitle:
      'Powers invitation emails, password resets, anomaly digests. Leave blank to disable — invites still work via copy-link.',
    keys: [
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_FROM',
      'SMTP_SECURE',
      'APP_BASE_URL',
    ],
  },
  {
    slug: 'stripe',
    title: 'Stripe + SaaS',
    subtitle:
      'Stripe keys (rotate live — the SDK client rebuilds on next call), public-signup toggle, automatic-tax, and the base URL used for Checkout redirects + email links.',
    keys: [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PUBLIC_BASE_URL',
      'STRIPE_AUTOMATIC_TAX',
      'PUBLIC_SIGNUP_ENABLED',
    ],
  },
  {
    slug: 'support',
    title: 'Support & feedback',
    subtitle:
      'Operator-configured help destination — surfaced as "Help & feature requests" in the sidebar and on every unauthenticated page.',
    keys: ['SUPPORT_URL'],
  },
  {
    slug: 'plaid',
    title: 'Plaid — bank sync',
    subtitle:
      'When enabled, /plaid lets you link accounts and import transactions automatically. PLAID_ENABLED=true requires all four keys. PLAID_ENV is "sandbox" or "production".',
    keys: ['PLAID_ENABLED', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'],
  },
  {
    slug: 'anomaly',
    title: 'Anomaly alerts',
    subtitle:
      'Flags unusual transactions on import — single transactions over the threshold, or merchant-level outliers (N× the median for that merchant).',
    keys: [
      'ANOMALY_ENABLED',
      'ANOMALY_LARGE_TXN_THRESHOLD_CENTS',
      'ANOMALY_MULTIPLIER',
      'ANOMALY_EMAIL_TO',
    ],
  },
  {
    slug: 'session',
    title: 'Web session',
    subtitle:
      'Automatically sign out users whose browser has been idle for the configured number of minutes. 0 disables the timer.',
    keys: ['WEB_INACTIVITY_TIMEOUT_MINUTES'],
  },
  {
    slug: 'perf-analysis',
    title: 'Performance analysis',
    subtitle:
      'How often the /health performance analyzer re-runs. Force an immediate run via "Run now" on /health.',
    keys: ['PERFORMANCE_ANALYSIS_INTERVAL_HOURS'],
  },
  {
    slug: 'perf-restart',
    title: 'Performance — restart required',
    subtitle:
      'Boot-only knobs. Edit them here, then click Restart server.',
    keys: [
      'HEAP_MAX_MB',
      'PG_POOL_MAX',
      'OCR_TIMEOUT_MS',
      'SLOW_QUERY_THRESHOLD_MS',
      'NODE_OPTIONS',
    ],
  },
  {
    slug: 'security',
    title: 'Security — restart required',
    subtitle:
      'Rotating these breaks things if done wrong. Restart for new values to apply.',
    keys: ['SESSION_SECRET', 'ATTACHMENT_ENCRYPTION_KEY'],
  },
];

const DESTRUCTIVE_CONFIRM: Record<string, string> = {
  SESSION_SECRET: 'rotate',
  ATTACHMENT_ENCRYPTION_KEY: 'DESTROY EXISTING',
};

type FilterId = 'all' | 'gui' | 'env' | 'restart' | 'secret';

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Toolbar state.
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterId>('all');
  // Rows recently saved — drives the green flash + 'saved' chip.
  // Each entry maps key → timestamp; we render the flash while
  // (now - ts) < 2000ms. A short-lived timer prunes stale ones.
  const [recentSaves, setRecentSaves] = useState<Record<string, number>>({});

  const searchRef = useRef<HTMLInputElement | null>(null);

  async function load(opts: { silent?: boolean } = {}) {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      setSettings(await api.listSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Keyboard: `/` focuses search (skip if the user is already typing
  // somewhere). Matches what every developer console + GitHub does.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Prune recentSaves so the flash decays. A single timer that
  // re-renders the page every second is cheaper than per-row timers.
  useEffect(() => {
    if (Object.keys(recentSaves).length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setRecentSaves((cur) => {
        const next: Record<string, number> = {};
        let changed = false;
        for (const [k, ts] of Object.entries(cur)) {
          if (now - ts < 2200) next[k] = ts;
          else changed = true;
        }
        return changed ? next : cur;
      });
    }, 500);
    return () => clearInterval(t);
  }, [recentSaves]);

  async function save(setting: AppSetting, newValue: string) {
    const scrollY = window.scrollY;
    setError(null);
    try {
      const r = await api.putSetting(setting.key, newValue);
      if (r.restart_required) setRestartNeeded(true);
      setRecentSaves((cur) => ({ ...cur, [setting.key]: Date.now() }));
      await load({ silent: true });
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function clearKey(setting: AppSetting) {
    if (
      !window.confirm(
        `Clear ${setting.label}? ${
          setting.env_fallback_present
            ? 'The .env value will take over.'
            : 'The feature will be unconfigured.'
        }`,
      )
    ) {
      return;
    }
    const scrollY = window.scrollY;
    setError(null);
    try {
      await api.clearSetting(setting.key);
      if (setting.restart_required) setRestartNeeded(true);
      setRecentSaves((cur) => ({ ...cur, [setting.key]: Date.now() }));
      await load({ silent: true });
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clear failed');
    }
  }

  async function doRestart() {
    if (
      !window.confirm(
        'Restart the server now? You will be briefly disconnected; docker compose auto-restart will bring the app back in a few seconds.',
      )
    ) {
      return;
    }
    setRestarting(true);
    try {
      await api.restartServer();
      setTimeout(() => window.location.reload(), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restart failed');
      setRestarting(false);
    }
  }

  // ── Derived: which keys pass current filters ──────────────
  const visibleByKey = useMemo(() => {
    const set = new Set<string>();
    const q = search.trim().toLowerCase();
    for (const s of settings) {
      if (q !== '') {
        const hay = `${s.key} ${s.label}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (filter === 'gui' && !s.configured_in_gui) continue;
      if (filter === 'env' && !s.env_fallback_present) continue;
      if (filter === 'restart' && !s.restart_required) continue;
      if (filter === 'secret' && !s.is_secret) continue;
      set.add(s.key);
    }
    return set;
  }, [settings, search, filter]);

  // Counts for the filter pills.
  const counts = useMemo(() => {
    const c = { all: 0, gui: 0, env: 0, restart: 0, secret: 0 };
    for (const s of settings) {
      c.all++;
      if (s.configured_in_gui) c.gui++;
      if (s.env_fallback_present) c.env++;
      if (s.restart_required) c.restart++;
      if (s.is_secret) c.secret++;
    }
    return c;
  }, [settings]);

  // Per-section visible-count + how many of them are restart-required
  // (drives the nav badge).
  const perSection = useMemo(() => {
    const m = new Map<string, { visible: number; restart: number }>();
    for (const sec of SECTIONS) {
      let visible = 0;
      let restart = 0;
      for (const key of sec.keys) {
        const s = settings.find((x) => x.key === key);
        if (!s) continue;
        if (!visibleByKey.has(key)) continue;
        visible++;
        if (s.restart_required && s.configured_in_gui) restart++;
      }
      m.set(sec.slug, { visible, restart });
    }
    return m;
  }, [settings, visibleByKey]);

  // Recently-changed strip: top 5 settings with updated_at.
  const recents = useMemo(() => {
    return [...settings]
      .filter((s) => s.updated_at !== null && s.updated_at !== undefined)
      .sort(
        (a, b) =>
          new Date(b.updated_at as string).getTime() -
          new Date(a.updated_at as string).getTime(),
      )
      .slice(0, 5);
  }, [settings]);

  const stagedCount = useMemo(() => {
    // Settings that ARE restart-required AND have a GUI-set value
    // (so an edit has been recorded that needs restart to apply).
    return settings.filter(
      (s) => s.restart_required && s.configured_in_gui,
    ).length;
  }, [settings]);

  function jumpToSection(slug: string) {
    const el = document.getElementById(`settings-section-${slug}`);
    if (!el) return;
    const headerOffset = 24;
    const top = el.getBoundingClientRect().top + window.scrollY - headerOffset;
    window.scrollTo({ top, behavior: 'smooth' });
  }
  function jumpToKey(key: string) {
    const el = document.getElementById(`settings-row-${key}`);
    if (!el) return;
    const headerOffset = 24;
    const top = el.getBoundingClientRect().top + window.scrollY - headerOffset;
    window.scrollTo({ top, behavior: 'smooth' });
    // Flash the row briefly so the user's eye lands.
    el.classList.add('settings-row-pulse');
    setTimeout(() => el.classList.remove('settings-row-pulse'), 1200);
  }

  return (
    <div className="settings-shell">
      <div className="settings-pageheader">
        <div>
          <h1 className="settings-h1">
            <span className="settings-h1-tick">╱╱</span> Settings
          </h1>
          <div className="settings-subtitle">
            Runtime configuration · <strong>{counts.all}</strong> keys
            {stagedCount > 0 && (
              <>
                {' · '}
                <span className="settings-staged">
                  <span className="settings-staged-dot" />
                  {stagedCount} staged for restart
                </span>
              </>
            )}
          </div>
        </div>
        {restartNeeded && (
          <button
            className="btn danger settings-restart-btn"
            type="button"
            disabled={restarting}
            onClick={() => void doRestart()}
          >
            <span aria-hidden>⏻ </span>
            {restarting ? 'Restarting…' : 'Restart server'}
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="settings-body">
          {/* ── Left rail nav ─────────────────────────────── */}
          <aside className="settings-nav" aria-label="Sections">
            <div className="settings-nav-label">NAVIGATE</div>
            <ul className="settings-nav-list">
              {SECTIONS.map((sec) => {
                const c = perSection.get(sec.slug) ?? { visible: 0, restart: 0 };
                if (c.visible === 0) return null;
                return (
                  <li key={sec.slug}>
                    <button
                      type="button"
                      className="settings-nav-item"
                      onClick={() => jumpToSection(sec.slug)}
                    >
                      <span className="settings-nav-title">{sec.title}</span>
                      <span className="settings-nav-counts">
                        {c.restart > 0 && (
                          <span
                            className="settings-nav-badge restart"
                            title={`${c.restart} change(s) staged for restart`}
                          >
                            ⟳ {c.restart}
                          </span>
                        )}
                        <span className="settings-nav-count">{c.visible}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* ── Content ────────────────────────────────────── */}
          <div className="settings-content">
            <div className="settings-toolbar">
              <div className="settings-search">
                <span className="settings-search-icon" aria-hidden>
                  ⌕
                </span>
                <input
                  ref={searchRef}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="search settings or paste a key…"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="settings-search-kbd" aria-hidden>
                  /
                </span>
              </div>
              <div className="settings-filters" role="tablist">
                <FilterChip
                  active={filter === 'all'}
                  count={counts.all}
                  onClick={() => setFilter('all')}
                >
                  All
                </FilterChip>
                <FilterChip
                  active={filter === 'gui'}
                  count={counts.gui}
                  variant="gui"
                  onClick={() => setFilter('gui')}
                >
                  GUI-set
                </FilterChip>
                <FilterChip
                  active={filter === 'restart'}
                  count={counts.restart}
                  variant="restart"
                  onClick={() => setFilter('restart')}
                >
                  ⟳ Restart req
                </FilterChip>
                <FilterChip
                  active={filter === 'env'}
                  count={counts.env}
                  variant="env"
                  onClick={() => setFilter('env')}
                >
                  .env fallback
                </FilterChip>
                <FilterChip
                  active={filter === 'secret'}
                  count={counts.secret}
                  variant="secret"
                  onClick={() => setFilter('secret')}
                >
                  ● Secret
                </FilterChip>
              </div>
            </div>

            {recents.length > 0 && (
              <div className="settings-recent">
                <div className="settings-recent-label">RECENTLY CHANGED</div>
                <div className="settings-recent-row">
                  {recents.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className="settings-recent-chip"
                      onClick={() => jumpToKey(s.key)}
                      title={`Jump to ${s.key}`}
                    >
                      <span className="settings-recent-key">{s.key}</span>
                      <span className="settings-recent-time">
                        {relativeTime(s.updated_at!)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {visibleByKey.size === 0 ? (
              <div className="settings-empty card">
                <p>
                  No settings match{' '}
                  {search ? (
                    <>
                      <code>{search}</code>
                    </>
                  ) : (
                    'the current filter'
                  )}
                  .
                </p>
                {(search || filter !== 'all') && (
                  <button
                    className="btn small"
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setFilter('all');
                    }}
                  >
                    Clear filter
                  </button>
                )}
              </div>
            ) : (
              SECTIONS.map((section) => {
                const visible = section.keys.filter((k) =>
                  visibleByKey.has(k),
                );
                if (visible.length === 0) return null;
                const sectionHasRestart = visible.some((k) => {
                  const s = settings.find((x) => x.key === k);
                  return s?.restart_required ?? false;
                });
                return (
                  <section
                    key={section.slug}
                    id={`settings-section-${section.slug}`}
                    className={`settings-section ${
                      sectionHasRestart ? 'has-restart' : ''
                    }`}
                  >
                    <header className="settings-section-head">
                      <h2 className="settings-section-title">{section.title}</h2>
                      <p className="settings-section-sub">{section.subtitle}</p>
                    </header>
                    <div className="card settings-list">
                      {visible.map((key) => {
                        const setting = settings.find((s) => s.key === key);
                        if (!setting) return null;
                        return (
                          <SettingRow
                            key={setting.key}
                            setting={setting}
                            recentlySaved={recentSaves[setting.key] !== undefined}
                            onSave={(v) => void save(setting, v)}
                            onClear={() => void clearKey(setting)}
                          />
                        );
                      })}
                      {section.slug === 'smtp' && <SmtpTestPanel />}
                    </div>
                  </section>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  children,
  active,
  count,
  variant,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  count: number;
  variant?: 'gui' | 'restart' | 'env' | 'secret';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-filter-chip ${active ? 'active' : ''} ${
        variant ?? ''
      }`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
    >
      <span>{children}</span>
      <span className="settings-filter-count">{count}</span>
    </button>
  );
}

function SmtpTestPanel() {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function run() {
    if (to.trim() === '') return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.smtpTest(to.trim());
      if (r.ok) {
        setResult({ ok: true, text: `Sent (Message-Id ${r.message_id ?? '—'})` });
      } else {
        setResult({
          ok: false,
          text: `Failed at ${r.stage ?? '?'}: ${r.reason ?? 'unknown'}`,
        });
      }
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof Error ? e.message : 'Test failed',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="smtp-test-row settings-smtp-test">
      <input
        type="email"
        placeholder="Send a test message to…"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={busy}
      />
      <button
        className="btn"
        type="button"
        onClick={() => void run()}
        disabled={busy || to.trim() === ''}
      >
        {busy ? 'Sending…' : 'Send test'}
      </button>
      {result && (
        <span className={`pill ${result.ok ? 'ok' : 'warn'}`}>
          {result.text}
        </span>
      )}
    </div>
  );
}

function SettingRow({
  setting,
  recentlySaved,
  onSave,
  onClear,
}: {
  setting: AppSetting;
  recentlySaved: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const destructiveConfirm = DESTRUCTIVE_CONFIRM[setting.key];
  const confirmRequired = !!destructiveConfirm && setting.configured_in_gui;
  const confirmMatch = !confirmRequired || confirmText === destructiveConfirm;

  const isUrlKey = URL_TYPED_KEYS.has(setting.key);
  const urlHint = isUrlKey ? checkUrlHint(value) : null;

  function commit() {
    if (value.trim() === '') return;
    if (!confirmMatch) return;
    if (urlHint !== null) return;
    onSave(value.trim());
    setEditing(false);
    setValue('');
    setConfirmText('');
  }

  // Status chips. Ordering: state first (live/restart), then provenance
  // (gui/env), then sensitivity (secret).
  const liveLabel = setting.restart_required ? 'RESTART REQ' : 'LIVE';
  const liveClass = setting.restart_required ? 'restart' : 'live';

  return (
    <div
      id={`settings-row-${setting.key}`}
      className={`settings-row ${
        setting.restart_required ? 'is-restart' : 'is-live'
      } ${recentlySaved ? 'settings-row-saved' : ''}`}
    >
      <div className="settings-row-body">
        <div className="settings-row-head">
          <div className="settings-row-label">
            <span className="settings-row-name">{setting.label}</span>
            <code className="settings-row-key">{setting.key}</code>
          </div>
          <div className="settings-row-chips">
            <span className={`pill ${liveClass}`}>{liveLabel}</span>
            {setting.configured_in_gui && (
              <span className="pill gui" title="Value is set via this UI">
                GUI
              </span>
            )}
            {setting.env_fallback_present && (
              <span
                className="pill env"
                title=".env value present on the host"
              >
                .env
              </span>
            )}
            {setting.is_secret && (
              <span className="pill secret" title="Stored as a secret">
                ● secret
              </span>
            )}
            {recentlySaved && (
              <span className="pill saved" aria-live="polite">
                ✓ saved
              </span>
            )}
          </div>
        </div>

        <div className="settings-row-value">
          {editing ? (
            <div className="settings-edit">
              {setting.key === 'AI_PROVIDER' ? (
                <select
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                >
                  <option value="">— Pick one —</option>
                  {AI_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              ) : setting.key === 'ANTHROPIC_MODEL' ? (
                <AiModelPicker
                  provider="claude"
                  value={value}
                  onChange={setValue}
                />
              ) : setting.key === 'OLLAMA_MODEL' ? (
                <AiModelPicker
                  provider="ollama"
                  value={value}
                  onChange={setValue}
                />
              ) : (
                <input
                  type={
                    setting.is_secret
                      ? 'password'
                      : isUrlKey
                        ? 'url'
                        : 'text'
                  }
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={
                    setting.is_secret
                      ? 'paste new value'
                      : isUrlKey
                        ? 'https://example.com'
                        : 'new value'
                  }
                  autoFocus
                />
              )}
              {urlHint !== null && <div className="hint warn">{urlHint}</div>}
              {setting.key === 'EIA_API_KEY' && (
                <div className="settings-hint muted">
                  Need a key?{' '}
                  <a
                    href="https://www.eia.gov/opendata/register.php"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Create one (free)
                  </a>{' '}
                  — it arrives by email in seconds.
                </div>
              )}
              {confirmRequired && (
                <div className="settings-confirm">
                  <span className="muted">
                    Type <code>{destructiveConfirm}</code> to confirm:
                  </span>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                </div>
              )}
              <div className="settings-edit-actions">
                <button
                  className="btn small"
                  type="button"
                  onClick={commit}
                  disabled={
                    !confirmMatch || value.trim() === '' || urlHint !== null
                  }
                >
                  Save
                </button>
                <button
                  className="btn secondary small"
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setValue('');
                    setConfirmText('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-display">
              <span className="settings-display-value">
                {setting.display_value ? (
                  <code>{setting.display_value}</code>
                ) : (
                  <span className="muted">— not configured</span>
                )}
              </span>
              <span className="settings-display-source">
                {setting.configured_in_gui
                  ? 'GUI'
                  : setting.env_fallback_present
                    ? '.env'
                    : 'default'}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="settings-row-actions">
        {!editing && (
          <button
            className="btn-link"
            type="button"
            onClick={() => setEditing(true)}
          >
            {setting.configured_in_gui ? 'Change' : 'Set'}
          </button>
        )}
        {!editing && setting.configured_in_gui && (
          <button className="btn-link danger" type="button" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      <div className="settings-row-accent" aria-hidden />
    </div>
  );
}

function AiModelPicker({
  provider,
  value,
  onChange,
}: {
  provider: 'claude' | 'ollama';
  value: string;
  onChange: (v: string) => void;
}) {
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.aiModels(provider);
        if (cancelled) return;
        setModels(r.models);
        setNote(r.note ?? null);
        if (value === '') {
          const rec = r.models.find((m) => m.recommended);
          if (rec) onChange(rec.id);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  if (loading) return <span className="muted">Loading models…</span>;
  if (models.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model id"
      />
    );
  }
  return (
    <div className="model-picker">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Pick a model —</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.recommended ? ' ★' : ''}
          </option>
        ))}
        <option value="__custom__">Custom (type below)…</option>
      </select>
      {value === '__custom__' && (
        <input
          type="text"
          placeholder="enter a custom model id"
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
      )}
      {models.find((m) => m.id === value)?.note && (
        <div className="muted" style={{ fontSize: 12 }}>
          {models.find((m) => m.id === value)!.note}
        </div>
      )}
      {note && (
        <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>
          {note}
        </div>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  const min = Math.round(abs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
