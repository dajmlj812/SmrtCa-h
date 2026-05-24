import nodemailer, { type Transporter } from 'nodemailer';
import { getEffectiveValue } from './settings.js';

/**
 * SMTP mailer. Builds a nodemailer transport on demand from
 * runtime-editable settings (SMTP_HOST, SMTP_PORT, SMTP_USER,
 * SMTP_PASS, SMTP_FROM, SMTP_SECURE), sends one message, and tears
 * down. For a single-instance self-hosted finance app the volume is
 * low enough that the per-call connection cost doesn't matter; an
 * "outbox" table + worker only earns its complexity at higher volume.
 *
 * Every send goes through `tryMail()` — when SMTP is unconfigured, the
 * function returns `{ sent: false, reason: 'smtp not configured' }`
 * instead of throwing. Callers (invite creation, future bill alerts)
 * use the return value to decide whether to fall back to the copy-link
 * path or surface a "configure SMTP" hint.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text body. Used as a fallback for HTML-disabled clients. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export interface MailResult {
  sent: boolean;
  /** Message-Id from the SMTP server when sent; null otherwise. */
  messageId?: string;
  /** Human-readable reason when `sent === false`. */
  reason?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

async function loadConfig(): Promise<SmtpConfig | null> {
  const [host, port, user, pass, from, secure] = await Promise.all([
    getEffectiveValue('SMTP_HOST'),
    getEffectiveValue('SMTP_PORT'),
    getEffectiveValue('SMTP_USER'),
    getEffectiveValue('SMTP_PASS'),
    getEffectiveValue('SMTP_FROM'),
    getEffectiveValue('SMTP_SECURE'),
  ]);
  if (host.trim() === '' || from.trim() === '') return null;
  const portNum = Number(port) || 587;
  return {
    host: host.trim(),
    port: portNum,
    user: user.trim(),
    pass: pass, // never trim — passwords can be whitespace-sensitive
    from: from.trim(),
    // SMTP_SECURE === 'true' implies TLS-on-connect (typically port 465).
    // Otherwise STARTTLS is negotiated when available — that's the
    // common case for ports 587 / 25.
    secure: secure.toLowerCase() === 'true',
  };
}

function buildTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user !== '' ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

/**
 * Send a message. Returns { sent: false } when SMTP is unconfigured;
 * throws when SMTP IS configured but the send itself fails — that's a
 * real error the caller should surface.
 */
export async function tryMail(msg: MailMessage): Promise<MailResult> {
  const cfg = await loadConfig();
  if (!cfg) {
    return {
      sent: false,
      reason: 'SMTP not configured — set SMTP_HOST and SMTP_FROM on the Settings page',
    };
  }
  const transport = buildTransport(cfg);
  try {
    const info = await transport.sendMail({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      // 0.17.2 — disable click + open tracking on every send.
      //
      // Every SmrtCash email is transactional (invitation,
      // verification, password reset, dunning, SMTP-test). For
      // those, tracking is a footgun: the click-tracking
      // rewriter wraps URLs through a redirect domain and can
      // corrupt them (Maileroo specifically mangled
      // `https://sub.domain.tld/...` into
      // `https://sub@domain.tld/...` because the host pattern
      // matched the FROM address). It also triggers safe-link
      // warnings in some clients and adds zero analytics value
      // for an account-flow email.
      //
      // `X-Maileroo-Track: no` is the documented Maileroo
      // header (controls both open + click tracking). On any
      // other SMTP relay the header is unrecognized and
      // silently ignored, so it's safe to set unconditionally.
      // If a future deployment ever wants tracking on, override
      // it in a wrapper rather than removing this default.
      headers: {
        'X-Maileroo-Track': 'no',
      },
    });
    return { sent: true, messageId: info.messageId };
  } finally {
    transport.close();
  }
}

/** Verify the configured SMTP connection (no send). Used by the Test button. */
export async function verifyConnection(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const cfg = await loadConfig();
  if (!cfg) {
    return { ok: false, reason: 'SMTP not configured' };
  }
  const transport = buildTransport(cfg);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    transport.close();
  }
}

/**
 * 0.15.4 — dunning email for a failed Stripe payment. Sent from
 * the `invoice.payment_failed` webhook handler. Body keeps it short
 * and points at /billing where the Stripe Customer Portal link
 * lives.
 */
export function renderDunningEmail(opts: {
  customerName: string | null;
  billingUrl: string;
  amountDueCents: number;
  currency: string; // ISO 4217 (usually 'usd')
}): { subject: string; text: string; html: string } {
  const greeting = opts.customerName ? `Hi ${opts.customerName},` : 'Hi,';
  const amount = `${opts.currency.toUpperCase()} ${(opts.amountDueCents / 100).toFixed(2)}`;
  const subject = `We couldn't process your SmrtCash payment`;
  const text = [
    greeting,
    ``,
    `We tried to charge your card for ${amount} but the payment didn't go`,
    `through. Your subscription is in a short grace period — features stay`,
    `available for the next few days while we retry.`,
    ``,
    `Update your payment method to avoid losing access:`,
    opts.billingUrl,
    ``,
    `If the card on file is correct and you're seeing this in error, the`,
    `billing page above also lets you contact us directly.`,
  ].join('\n');
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>We tried to charge your card for <strong>${escapeHtml(amount)}</strong>`,
    `but the payment didn't go through. Your subscription is in a short`,
    `grace period &mdash; features stay available for the next few days`,
    `while we retry.</p>`,
    `<p><a href="${escapeAttr(opts.billingUrl)}"`,
    `style="display:inline-block;padding:10px 18px;background:#ef4444;`,
    `color:#fff;border-radius:4px;text-decoration:none">Update payment method</a></p>`,
    `<p style="color:#6b7280;font-size:0.9em">Or paste this URL into your browser:<br>`,
    `<code>${escapeHtml(opts.billingUrl)}</code></p>`,
  ].join(' ');
  return { subject, text, html };
}

/**
 * 0.16.2 — password reset email. Sent from
 * /api/auth/password-reset-request when the email matches a real
 * user. Links land on /reset-password?token=... which calls
 * /api/auth/password-reset-confirm with the new password.
 *
 * Body intentionally calls out that "you can ignore this if you
 * didn't request it" — anti-phishing copy that also pre-empts
 * support questions about unexpected reset emails (a
 * not-so-rare side effect of typo'd email addresses on signup).
 */
export function renderPasswordResetEmail(opts: {
  resetUrl: string;
  expiresAt: string;
}): { subject: string; text: string; html: string } {
  const subject = `Reset your SmrtCash password`;
  const text = [
    `We received a request to reset your SmrtCash password.`,
    ``,
    `Click the link below to choose a new password:`,
    ``,
    opts.resetUrl,
    ``,
    `The link expires ${opts.expiresAt}. If you didn't request a`,
    `password reset you can safely ignore this email — your`,
    `password won't change unless someone with this link sets a`,
    `new one.`,
  ].join('\n');
  const html = [
    `<p>We received a request to reset your SmrtCash password.</p>`,
    `<p>Click the button below to choose a new password:</p>`,
    `<p><a href="${escapeAttr(opts.resetUrl)}"`,
    `style="display:inline-block;padding:10px 18px;background:#6366f1;`,
    `color:#fff;border-radius:4px;text-decoration:none">Reset password</a></p>`,
    `<p style="color:#6b7280;font-size:0.9em">Or paste this URL into your browser:<br>`,
    `<code>${escapeHtml(opts.resetUrl)}</code></p>`,
    `<p style="color:#6b7280;font-size:0.85em">Link expires ${escapeHtml(opts.expiresAt)}.`,
    `If you didn't request a reset, ignore this email — your password won't change.</p>`,
  ].join(' ');
  return { subject, text, html };
}

/**
 * 0.16.0 — verification email for new public signups. Sent from
 * /api/auth/signup; the user clicks the link to land on
 * /verify-email?token=... which calls /api/auth/verify-email.
 */
export function renderVerificationEmail(opts: {
  verifyUrl: string;
  expiresAt: string;
}): { subject: string; text: string; html: string } {
  const subject = `Confirm your SmrtCash email`;
  const text = [
    `Welcome to SmrtCash!`,
    ``,
    `Click the link below to confirm your email address and finish`,
    `creating your account:`,
    ``,
    opts.verifyUrl,
    ``,
    `The link expires ${opts.expiresAt}. If you didn't sign up for`,
    `SmrtCash you can safely ignore this email — the address you`,
    `received it at will not be used for anything else.`,
  ].join('\n');
  const html = [
    `<p>Welcome to SmrtCash!</p>`,
    `<p>Click the button below to confirm your email address and`,
    `finish creating your account:</p>`,
    `<p><a href="${escapeAttr(opts.verifyUrl)}"`,
    `style="display:inline-block;padding:10px 18px;background:#10b981;`,
    `color:#fff;border-radius:4px;text-decoration:none">Confirm email</a></p>`,
    `<p style="color:#6b7280;font-size:0.9em">Or paste this URL into your browser:<br>`,
    `<code>${escapeHtml(opts.verifyUrl)}</code></p>`,
    `<p style="color:#6b7280;font-size:0.85em">Link expires ${escapeHtml(opts.expiresAt)}.</p>`,
  ].join(' ');
  return { subject, text, html };
}

/** Render the email body for an invitation link. */
export function renderInvitationEmail(opts: {
  tenantName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresAt: string;
}): { subject: string; text: string; html: string } {
  const subject = `You're invited to join ${opts.tenantName} on SmrtCash`;
  const text = [
    `${opts.inviterName} has invited you to join "${opts.tenantName}" on SmrtCash`,
    `as a ${opts.role}.`,
    ``,
    `Accept your invitation:`,
    opts.acceptUrl,
    ``,
    `This invitation expires ${opts.expiresAt}.`,
    ``,
    `If you weren't expecting this email, you can safely ignore it — the`,
    `link is only useful to whoever you forward it to.`,
  ].join('\n');
  const html = [
    `<p>${escapeHtml(opts.inviterName)} has invited you to join`,
    `<strong>${escapeHtml(opts.tenantName)}</strong> on SmrtCash`,
    `as a <strong>${escapeHtml(opts.role)}</strong>.</p>`,
    `<p><a href="${escapeAttr(opts.acceptUrl)}"`,
    `style="display:inline-block;padding:10px 18px;background:#6366f1;`,
    `color:#fff;border-radius:4px;text-decoration:none">Accept invitation</a></p>`,
    `<p style="color:#6b7280;font-size:0.9em">Or paste this URL into your browser:<br>`,
    `<code>${escapeHtml(opts.acceptUrl)}</code></p>`,
    `<p style="color:#6b7280;font-size:0.85em">This invitation expires ${escapeHtml(opts.expiresAt)}.</p>`,
  ].join(' ');
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
