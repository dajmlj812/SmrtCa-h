import { describe, it, expect } from 'vitest';
import { validateUrlSetting } from '../../src/routes/settings.js';

describe('validateUrlSetting (0.18.12)', () => {
  it('accepts well-formed https URLs', () => {
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'https://example.com')).toBeNull();
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'https://app.smrtcash.io/')).toBeNull();
    expect(validateUrlSetting('SUPPORT_URL', 'https://support.example.com/help')).toBeNull();
  });

  it('accepts http for dev / private deploys', () => {
    expect(validateUrlSetting('OLLAMA_BASE_URL', 'http://localhost:11434')).toBeNull();
    expect(validateUrlSetting('OLLAMA_BASE_URL', 'http://10.0.0.5:11434')).toBeNull();
  });

  it('rejects non-URLs with a clear message', () => {
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'not a url')).toMatch(/must be a valid URL/);
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'example.com')).toMatch(/must be a valid URL/);
    expect(validateUrlSetting('PUBLIC_BASE_URL', '')).toMatch(/must be a valid URL/);
  });

  it('rejects non-http(s) schemes', () => {
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'ftp://example.com')).toMatch(/http:|https:/);
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'file:///etc/passwd')).toMatch(/http:|https:/);
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'javascript:alert(1)')).toMatch(/http:|https:/);
  });

  it('catches the @-instead-of-. typo that motivated this slice', () => {
    // This is the exact bug from the smrtcash-test deploy.
    const r = validateUrlSetting(
      'PUBLIC_BASE_URL',
      'https://smrtcash-test@builditsmrt.com',
    );
    expect(r).not.toBeNull();
    expect(r).toMatch(/typo of/);
  });

  it('catches the @-typo on simpler hostnames too', () => {
    expect(
      validateUrlSetting('PUBLIC_BASE_URL', 'https://app@example.com'),
    ).toMatch(/typo of/);
  });

  // Note: `new URL('https:///path')` normalizes the empty host
  // segment away in Node 22's WHATWG parser, so we don't bother
  // asserting on it. The other checks above already cover the
  // realistic typo paths.
});
