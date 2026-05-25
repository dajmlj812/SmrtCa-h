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
 * 0.18.7 — shared HTML shell for every outbound email.
 *
 * Goal: every BITS email gets the same header/footer/button styling
 * so operators can recognize the SmrtCash brand at a glance, and so
 * a single visual update doesn't need 4 edits. The shell is
 * inline-styled (no <head><style>) because the major email clients
 * (Gmail, Outlook, iOS Mail) strip <style> blocks but respect
 * inline style attributes.
 *
 * Callers pass:
 *   - title       — the H1 (e.g. "Reset your SmrtCash password")
 *   - intro       — a short paragraph above the CTA (escaped)
 *   - ctaText     — button label (e.g. "Reset password")
 *   - ctaUrl      — the URL the button points at + the fallback
 *                   "or paste this URL" block uses
 *   - bodyHtmlSafe — extra trailing HTML (already escaped — caller
 *                    is responsible). Used for "this link expires
 *                    at X" footnotes.
 *   - ctaColor    — optional brand color for the button. Defaults
 *                   to BITS indigo (#4f46e5).
 */
export interface EmailShellOptions {
  title: string;
  intro: string;
  ctaText: string;
  ctaUrl: string;
  bodyHtmlSafe?: string;
  ctaColor?: string;
}

const BITS_HEADER_BG = '#0f172a';
const BRAND_LINK = 'https://builditsmrt.com';

export function renderEmailShell(opts: EmailShellOptions): string {
  const cta = opts.ctaColor ?? '#4f46e5';
  return [
    `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08)">`,
    `<tr><td style="background:${BITS_HEADER_BG};padding:18px 24px;color:#ffffff;font-weight:700;font-size:18px;letter-spacing:-0.01em">`,
    `Smrt<span style="color:#4f8cff">Cash</span>`,
    `</td></tr>`,
    `<tr><td style="padding:24px">`,
    `<h1 style="margin:0 0 12px;font-size:20px;letter-spacing:-0.01em">${escapeHtml(opts.title)}</h1>`,
    `<p style="margin:0 0 18px;line-height:1.5">${escapeHtml(opts.intro)}</p>`,
    `<p style="margin:0 0 18px"><a href="${escapeAttr(opts.ctaUrl)}" style="display:inline-block;padding:10px 18px;background:${cta};color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(opts.ctaText)}</a></p>`,
    `<p style="margin:0 0 6px;color:#6b7280;font-size:13px">Or paste this URL into your browser:</p>`,
    `<p style="margin:0 0 18px;word-break:break-all"><code style="background:#f6f8fa;padding:4px 6px;border-radius:4px;font-size:12px">${escapeHtml(opts.ctaUrl)}</code></p>`,
    opts.bodyHtmlSafe ? `<div style="color:#6b7280;font-size:13px;line-height:1.5">${opts.bodyHtmlSafe}</div>` : '',
    `</td></tr>`,
    `<tr><td style="background:#f6f8fa;padding:14px 24px;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb">`,
    `SmrtCash &middot; developed by <a href="${BRAND_LINK}" style="color:#6b7280">BuildITSmrt, LLC.</a>`,
    `</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join('');
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
  const html = renderEmailShell({
    title: subject,
    intro: `${greeting} we tried to charge your card for ${amount} but the payment didn't go through. Your subscription is in a short grace period — features stay available for the next few days while we retry.`,
    ctaText: 'Update payment method',
    ctaUrl: opts.billingUrl,
    ctaColor: '#ef4444',
    bodyHtmlSafe: `If the card on file is correct and you're seeing this in error, the billing page above also lets you contact us directly.`,
  });
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
  const html = renderEmailShell({
    title: subject,
    intro: 'We received a request to reset your SmrtCash password. Click the button below to choose a new one.',
    ctaText: 'Reset password',
    ctaUrl: opts.resetUrl,
    bodyHtmlSafe: `Link expires ${escapeHtml(opts.expiresAt)}. If you didn't request a reset, ignore this email — your password won't change unless someone with this link sets a new one.`,
  });
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
  const html = renderEmailShell({
    title: 'Welcome to SmrtCash',
    intro: 'Click the button below to confirm your email address and finish creating your account.',
    ctaText: 'Confirm email',
    ctaUrl: opts.verifyUrl,
    ctaColor: '#10b981',
    bodyHtmlSafe: `Link expires ${escapeHtml(opts.expiresAt)}. If you didn't sign up for SmrtCash you can safely ignore this email — the address you received it at will not be used for anything else.`,
  });
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
  const html = renderEmailShell({
    title: `You're invited to ${opts.tenantName}`,
    intro: `${opts.inviterName} has invited you to join "${opts.tenantName}" on SmrtCash as a ${opts.role}.`,
    ctaText: 'Accept invitation',
    ctaUrl: opts.acceptUrl,
    bodyHtmlSafe: `This invitation expires ${escapeHtml(opts.expiresAt)}. If you weren't expecting this email, you can safely ignore it — the link is only useful to whoever you forward it to.`,
  });
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
