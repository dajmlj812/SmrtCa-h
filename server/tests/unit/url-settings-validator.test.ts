import { describe, it, expect } from 'vitest';
import { validateUrlSetting } from '../../src/routes/settings.js';

describe('validateUrlSetting (0.18.12)', () => {
  it('accepts well-formed https URLs', () => {
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'https://example.com')).toBeNull();
    expect(validateUrlSetting('PUBLIC_BASE_URL', 'https://app.smrtcash.io/')).toBeNull();
    expect(validateUrlSetting('SUPPORT_URL', 'https://support.example.com/help')).toBeNull();
  });

  it('accepts http for a public-hostname dev deploy', () => {
    // http (not https) is allowed; the SSRF gate only objects to
    // private/loopback *IP literals*, not to the http scheme itself.
    expect(validateUrlSetting('OLLAMA_BASE_URL', 'http://ollama.example.com:11434')).toBeNull();
  });

  it('rejects private/loopback IP literals (F-23 SSRF guard)', () => {
    // 0.18.12 accepted these; the 2026-05-25 security audit (F-23)
    // tightened validateUrlSetting to refuse server-initiated traffic
    // to private ranges (loopback, RFC-1918, link-local/IMDS). A
    // settings save pointing OLLAMA_BASE_URL at the LAN is now blocked.
    expect(validateUrlSetting('OLLAMA_BASE_URL', 'http://10.0.0.5:11434'))
      .toMatch(/private\/loopback/);
    expect(validateUrlSetting('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'))
      .toMatch(/private\/loopback/);
    expect(validateUrlSetting('OLLAMA_BASE_URL', 'http://169.254.169.254/'))
      .toMatch(/private\/loopback/);
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
