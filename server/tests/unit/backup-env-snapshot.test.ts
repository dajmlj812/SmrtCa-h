import { describe, it, expect } from 'vitest';
import { buildEnvSnapshot } from '../../src/domain/backup-runner.js';
import { KNOWN_SETTINGS } from '../../src/domain/settings.js';

/**
 * F-13 (security audit 2026-05-25) launch-gate test.
 *
 * The env.snapshot.json inside every backup must NEVER contain any
 * secret-class env value. A leaked backup with SESSION_SECRET or
 * ATTACHMENT_ENCRYPTION_KEY defeats the entire per-tenant envelope-
 * encryption design. If a future change marks a new key as secret OR
 * accidentally removes the isSecret flag from an existing one, this
 * test fails before the regression ships.
 */
describe('buildEnvSnapshot — secret hygiene (F-13)', () => {
  const FAKE_ENV: NodeJS.ProcessEnv = {
    // Secret-class entries (must be excluded)
    ANTHROPIC_API_KEY: 'sk-ant-test-12345',
    EIA_API_KEY: 'eia-test-67890',
    SMTP_PASS: 'super-secret-smtp-pw',
    SESSION_SECRET: 'cookie-signing-key-32-bytes-base64',
    ATTACHMENT_ENCRYPTION_KEY: 'KEK-wraps-every-tenant-DEK-32B',
    PLAID_SECRET: 'plaid-test-shhh',
    STRIPE_SECRET_KEY: 'sk_test_51OgFakeValue',
    STRIPE_WEBHOOK_SECRET: 'whsec_FakeWebhookSecret',
    // Non-secret entries (must be included)
    AI_PROVIDER: 'claude',
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    PUBLIC_BASE_URL: 'https://smrtcash.example.com',
    SUPPORT_URL: 'https://support.example.com',
    STRIPE_AUTOMATIC_TAX: 'false',
    PUBLIC_SIGNUP_ENABLED: 'true',
    // Unknown key (must be ignored — not in KNOWN_SETTINGS)
    SOME_RANDOM_VAR: 'not-tracked-by-snapshot',
  };

  it('omits every isSecret:true key', () => {
    const { envSnapshot } = buildEnvSnapshot(FAKE_ENV);
    const secretKeys = KNOWN_SETTINGS.filter((m) => m.isSecret).map((m) => m.key);
    for (const k of secretKeys) {
      expect(envSnapshot).not.toHaveProperty(k);
    }
  });

  it('includes non-secret keys that are present in the env', () => {
    const { envSnapshot } = buildEnvSnapshot(FAKE_ENV);
    expect(envSnapshot.AI_PROVIDER).toBe('claude');
    expect(envSnapshot.PUBLIC_BASE_URL).toBe('https://smrtcash.example.com');
    expect(envSnapshot.SUPPORT_URL).toBe('https://support.example.com');
  });

  it('ignores env vars that are not in KNOWN_SETTINGS', () => {
    const { envSnapshot } = buildEnvSnapshot(FAKE_ENV);
    expect(envSnapshot).not.toHaveProperty('SOME_RANDOM_VAR');
  });

  it('skips empty-string and undefined values for non-secret keys', () => {
    const env: NodeJS.ProcessEnv = {
      AI_PROVIDER: '', // empty string
      ANTHROPIC_MODEL: undefined, // undefined
      SUPPORT_URL: 'https://x.example/',
    };
    const { envSnapshot } = buildEnvSnapshot(env);
    expect(envSnapshot).not.toHaveProperty('AI_PROVIDER');
    expect(envSnapshot).not.toHaveProperty('ANTHROPIC_MODEL');
    expect(envSnapshot.SUPPORT_URL).toBe('https://x.example/');
  });

  it('returns the list of omitted secret keys (for the snapshot manifest)', () => {
    const { omittedSecrets } = buildEnvSnapshot(FAKE_ENV);
    const expected = KNOWN_SETTINGS.filter((m) => m.isSecret).map((m) => m.key);
    expect(omittedSecrets.sort()).toEqual(expected.sort());
  });

  // Belt + suspenders: assert the known-secret list looks sane. If
  // someone removes one of these flags in a future change, this test
  // tells them to think twice. Add new entries if/when the schema grows.
  it('keeps the high-impact secrets flagged isSecret:true', () => {
    const mustBeSecret = [
      'SESSION_SECRET',
      'ATTACHMENT_ENCRYPTION_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'SMTP_PASS',
      'ANTHROPIC_API_KEY',
      'PLAID_SECRET',
      'EIA_API_KEY',
    ];
    for (const k of mustBeSecret) {
      const meta = KNOWN_SETTINGS.find((m) => m.key === k);
      expect(meta, `KNOWN_SETTINGS is missing ${k}`).toBeDefined();
      expect(meta!.isSecret, `${k} must be flagged isSecret:true`).toBe(true);
    }
  });
});
