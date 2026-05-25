import { describe, it, expect } from 'vitest';
import {
  renderDunningEmail,
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderVerificationEmail,
} from '../../src/domain/mailer.js';

/**
 * 0.18.7 — every outbound email renderer must emit HTML containing
 * the shared shell's marker so a future contributor can't ship a
 * text-only or hand-rolled email by accident. The marker is the
 * BITS footer line ("developed by BuildITSmrt, LLC.") which only
 * appears via renderEmailShell.
 */

const SHELL_MARKER = 'BuildITSmrt, LLC.';

describe('renderEmailShell wraps every renderer (0.18.7)', () => {
  it('verification email uses the shell', () => {
    const r = renderVerificationEmail({
      verifyUrl: 'https://example.com/verify-email?token=abc',
      expiresAt: '2026-06-01 12:00',
    });
    expect(r.html).toContain(SHELL_MARKER);
    expect(r.html).toContain('https://example.com/verify-email?token=abc');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('password-reset email uses the shell', () => {
    const r = renderPasswordResetEmail({
      resetUrl: 'https://example.com/reset-password?token=xyz',
      expiresAt: '2026-06-01 12:00',
    });
    expect(r.html).toContain(SHELL_MARKER);
    expect(r.html).toContain('https://example.com/reset-password?token=xyz');
  });

  it('invitation email uses the shell', () => {
    const r = renderInvitationEmail({
      tenantName: 'The Smith Household',
      inviterName: 'Alice',
      role: 'spouse',
      acceptUrl: 'https://example.com/invite/abc123',
      expiresAt: '2026-06-15 12:00',
    });
    expect(r.html).toContain(SHELL_MARKER);
    expect(r.html).toContain('https://example.com/invite/abc123');
    expect(r.html).toContain('The Smith Household');
  });

  it('dunning email uses the shell', () => {
    const r = renderDunningEmail({
      customerName: 'Bob',
      billingUrl: 'https://example.com/billing',
      amountDueCents: 4_99,
      currency: 'usd',
    });
    expect(r.html).toContain(SHELL_MARKER);
    expect(r.html).toContain('https://example.com/billing');
    expect(r.html).toContain('USD 4.99');
  });
});
