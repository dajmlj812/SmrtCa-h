import { randomUUID } from 'node:crypto';
import { parseOfx } from '../import/parsers/ofx.js';
import type { ParsedTransaction, RowError } from '../import/types.js';

/**
 * OFX Direct Connect protocol layer (Phase 8.1).
 *
 * Implements the small slice of OFX 1.x SGML needed to download
 * transaction history from a bank's `ofx_url`:
 *
 *   1. Build a SIGNONMSGSRQV1 + (BANKMSGSRQV1|CREDITCARDMSGSRQV1)
 *      request with a STMTTRNRQ inside.
 *   2. POST it to the bank with Content-Type: application/x-ofx.
 *   3. Hand the response body to the existing OFX file parser.
 *
 * We deliberately speak OFX 1.x (SGML, VERSION:102) instead of OFX
 * 2.x (XML, VERSION:200) — 1.x has the broadest bank support and the
 * SGML parser in import/parsers/ofx.ts handles either.
 */

export interface OfxDcConnection {
  ofxUrl: string;
  ofxOrg: string;
  ofxFid: string;
  ofxAppId: string;
  ofxAppVersion: string;
  intuBid?: string | null;
  username: string;
  password: string;
  bankAcctId: string;
  bankAcctType:
    | 'CHECKING'
    | 'SAVINGS'
    | 'MONEYMRKT'
    | 'CREDITLINE'
    | 'CREDITCARD';
  bankId?: string | null;
}

export interface OfxStmtRequest {
  connection: OfxDcConnection;
  startDate: Date;
  endDate: Date;
}

export interface OfxFetchResult {
  formatId: string;
  formatName: string;
  transactions: ParsedTransaction[];
  errors: RowError[];
  rawResponseSize: number;
}

export type OfxDcFailureKind =
  | 'http_error'
  | 'auth_failed'
  | 'parse_error'
  | 'transport_error';

export class OfxDcError extends Error {
  constructor(public readonly kind: OfxDcFailureKind, message: string) {
    super(message);
    this.name = 'OfxDcError';
  }
}

/** Format a Date as OFX's YYYYMMDDHHMMSS (UTC). */
export function formatOfxDateTime(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}${hh}${mm}${ss}`;
}

/**
 * Build the OFX 1.x SGML request body for a statement download.
 * The OFXHEADER block plus a blank line MUST precede the `<OFX>` tag
 * — many banks reject requests that don't strictly conform.
 */
export function buildOfxStmtRequest(req: OfxStmtRequest): string {
  const { connection: c, startDate, endDate } = req;
  const dtClient = formatOfxDateTime(new Date());
  const dtStart = formatOfxDateTime(startDate);
  const dtEnd = formatOfxDateTime(endDate);
  const trnUid = randomUUID().replace(/-/g, '').slice(0, 32);

  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
  ].join('\r\n');

  const signon = [
    '<SIGNONMSGSRQV1>',
    '<SONRQ>',
    `<DTCLIENT>${dtClient}`,
    `<USERID>${escapeSgml(c.username)}`,
    `<USERPASS>${escapeSgml(c.password)}`,
    '<LANGUAGE>ENG',
    '<FI>',
    `<ORG>${escapeSgml(c.ofxOrg)}`,
    `<FID>${escapeSgml(c.ofxFid)}`,
    '</FI>',
    `<APPID>${escapeSgml(c.ofxAppId)}`,
    `<APPVER>${escapeSgml(c.ofxAppVersion)}`,
    c.intuBid ? `<INTU.BID>${escapeSgml(c.intuBid)}` : '',
    '</SONRQ>',
    '</SIGNONMSGSRQV1>',
  ]
    .filter((s) => s !== '')
    .join('\r\n');

  const body =
    c.bankAcctType === 'CREDITCARD'
      ? buildCreditCardStmtRq(c, dtStart, dtEnd, trnUid)
      : buildBankStmtRq(c, dtStart, dtEnd, trnUid);

  return [header, '<OFX>', signon, body, '</OFX>', ''].join('\r\n');
}

function buildBankStmtRq(
  c: OfxDcConnection,
  dtStart: string,
  dtEnd: string,
  trnUid: string,
): string {
  return [
    '<BANKMSGSRQV1>',
    '<STMTTRNRQ>',
    `<TRNUID>${trnUid}`,
    '<CLTCOOKIE>1',
    '<STMTRQ>',
    '<BANKACCTFROM>',
    `<BANKID>${escapeSgml(c.bankId ?? '')}`,
    `<ACCTID>${escapeSgml(c.bankAcctId)}`,
    `<ACCTTYPE>${c.bankAcctType}`,
    '</BANKACCTFROM>',
    '<INCTRAN>',
    `<DTSTART>${dtStart}`,
    `<DTEND>${dtEnd}`,
    '<INCLUDE>Y',
    '</INCTRAN>',
    '</STMTRQ>',
    '</STMTTRNRQ>',
    '</BANKMSGSRQV1>',
  ].join('\r\n');
}

function buildCreditCardStmtRq(
  c: OfxDcConnection,
  dtStart: string,
  dtEnd: string,
  trnUid: string,
): string {
  return [
    '<CREDITCARDMSGSRQV1>',
    '<CCSTMTTRNRQ>',
    `<TRNUID>${trnUid}`,
    '<CLTCOOKIE>1',
    '<CCSTMTRQ>',
    '<CCACCTFROM>',
    `<ACCTID>${escapeSgml(c.bankAcctId)}`,
    '</CCACCTFROM>',
    '<INCTRAN>',
    `<DTSTART>${dtStart}`,
    `<DTEND>${dtEnd}`,
    '<INCLUDE>Y',
    '</INCTRAN>',
    '</CCSTMTRQ>',
    '</CCSTMTTRNRQ>',
    '</CREDITCARDMSGSRQV1>',
  ].join('\r\n');
}

function escapeSgml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Inspect a SONRS response for a non-zero status code. Banks return
 * `<CODE>15500` for invalid credentials, `<CODE>15501` for must-change-
 * password, etc. We treat any non-zero SONRS code as auth failure.
 */
function extractSonrsCode(responseBody: string): { code: number; message: string } | null {
  const sonrsMatch = responseBody.match(/<SONRS>([\s\S]*?)<\/SONRS>/i);
  if (!sonrsMatch) return null;
  const sonrs = sonrsMatch[1]!;
  const codeMatch = sonrs.match(/<CODE>\s*(\d+)/);
  if (!codeMatch) return null;
  const code = Number(codeMatch[1]);
  const messageMatch = sonrs.match(/<MESSAGE>\s*([^<\r\n]+)/);
  const message = messageMatch ? messageMatch[1]!.trim() : '';
  return { code, message };
}

/** Injectable fetch — production callers default to global `fetch`. */
export type FetchLike = typeof fetch;

export interface PostOfxOptions {
  fetchImpl?: FetchLike;
  /** Defaults to 60s. Banks are slow. */
  timeoutMs?: number;
}

/**
 * POST an OFX request body to the bank and return the response body
 * as a string. Throws an OfxDcError categorized by failure kind.
 */
export async function postOfxRequest(
  url: string,
  body: string,
  opts: PostOfxOptions = {},
): Promise<string> {
  // F-23 — re-check at fetch time so DNS rebinding (resolver returns
  // 8.8.8.8 at save time, 127.0.0.1 at fetch time) doesn't slip past
  // the settings-time check. The import is dynamic to avoid a circular
  // dependency with util/url-safety pulling in dns lookups.
  const { assertSafeUrlForFetch } = await import('../util/url-safety.js');
  await assertSafeUrlForFetch(url);
  const f = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await f(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ofx',
        Accept: 'application/x-ofx, application/xml, */*',
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OfxDcError(
        'http_error',
        `Bank returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return text;
  } catch (err) {
    if (err instanceof OfxDcError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OfxDcError(
        'transport_error',
        `Bank request timed out after ${opts.timeoutMs ?? 60_000} ms`,
      );
    }
    throw new OfxDcError(
      'transport_error',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-shot: build request, POST, parse response, return transactions.
 * The caller (data source / sync runner) handles persistence + cursor
 * tracking.
 */
export async function fetchOfxStatement(
  req: OfxStmtRequest,
  opts: PostOfxOptions = {},
): Promise<OfxFetchResult> {
  const requestBody = buildOfxStmtRequest(req);
  const responseBody = await postOfxRequest(
    req.connection.ofxUrl,
    requestBody,
    opts,
  );

  const sonrs = extractSonrsCode(responseBody);
  if (sonrs && sonrs.code !== 0) {
    // 15500/15501/15502 are the standard OFX auth-related codes.
    const kind: OfxDcFailureKind =
      sonrs.code >= 15500 && sonrs.code < 15600 ? 'auth_failed' : 'parse_error';
    throw new OfxDcError(
      kind,
      `OFX status ${sonrs.code}${sonrs.message ? `: ${sonrs.message}` : ''}`,
    );
  }

  try {
    const parsed = parseOfx(Buffer.from(responseBody, 'utf-8'), 'response.ofx');
    return {
      formatId: parsed.formatId,
      formatName: parsed.formatName,
      transactions: parsed.transactions,
      errors: parsed.errors,
      rawResponseSize: responseBody.length,
    };
  } catch (err) {
    throw new OfxDcError(
      'parse_error',
      err instanceof Error ? err.message : String(err),
    );
  }
}
