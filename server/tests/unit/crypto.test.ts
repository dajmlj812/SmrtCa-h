import { describe, it, expect } from 'vitest';
import { encryptString, decryptString } from '../../src/domain/crypto.js';

describe('domain/crypto AES-256-GCM (0.11.1)', () => {
  it('round-trips a string', () => {
    const ct = encryptString('hello world');
    expect(ct.length).toBeGreaterThan(28); // IV(12) + tag(16)
    expect(decryptString(ct)).toBe('hello world');
  });

  it('encrypts produce different ciphertext per call (random IV)', () => {
    const a = encryptString('same plaintext');
    const b = encryptString('same plaintext');
    expect(a.equals(b)).toBe(false);
    expect(decryptString(a)).toBe('same plaintext');
    expect(decryptString(b)).toBe('same plaintext');
  });

  it('rejects a truncated ciphertext', () => {
    expect(() => decryptString(Buffer.from('short'))).toThrow();
  });

  it('rejects a tampered tag', () => {
    const ct = encryptString('original');
    ct[ct.length - 1] = ct[ct.length - 1]! ^ 0xff;
    expect(() => decryptString(ct)).toThrow();
  });

  it('handles unicode + long strings', () => {
    const plain = 'café — 🏦 — Σ — ' + 'a'.repeat(2048);
    expect(decryptString(encryptString(plain))).toBe(plain);
  });
});
