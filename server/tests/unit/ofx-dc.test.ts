import { describe, it, expect } from 'vitest';
import {
  buildOfxStmtRequest,
  fetchOfxStatement,
  formatOfxDateTime,
  OfxDcError,
  type OfxDcConnection,
  type FetchLike,
} from '../../src/domain/ofx-dc.js';

const BASE_CONN: OfxDcConnection = {
  ofxUrl: 'https://example.bank/ofx',
  ofxOrg: 'ExampleBank',
  ofxFid: '1001',
  ofxAppId: 'QWIN',
  ofxAppVersion: '2700',
  intuBid: null,
  username: 'user@example.com',
  password: 'sup3r-s3cret',
  bankAcctId: '000111222',
  bankAcctType: 'CHECKING',
  bankId: '021000021',
};

function fakeFetchOk(body: string): FetchLike {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/x-ofx' },
    })) as unknown as FetchLike;
}

function okOfxResponse(opts: { type: 'BANK' | 'CC'; statusCode?: number; message?: string } = { type: 'BANK' }): string {
  const code = opts.statusCode ?? 0;
  const message = opts.message ?? '';
  const bank = [
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<TRNUID>X',
    `<STATUS><CODE>${code}<SEVERITY>INFO${message ? `<MESSAGE>${message}` : ''}</STATUS>`,
    '<STMTRS>',
    '<CURDEF>USD',
    '<BANKACCTFROM>',
    '<BANKID>021000021',
    '<ACCTID>000111222',
    '<ACCTTYPE>CHECKING',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20260301',
    '<DTEND>20260315',
    '<STMTTRN>',
    '<TRNTYPE>DEBIT',
    '<DTPOSTED>20260301',
    '<TRNAMT>-12.34',
    '<FITID>R1',
    '<NAME>Test Merchant',
    '</STMTTRN>',
    '</BANKTRANLIST>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
  ].join('\r\n');
  return [
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
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    `<STATUS><CODE>${code}<SEVERITY>INFO${message ? `<MESSAGE>${message}` : ''}</STATUS>`,
    '<DTSERVER>20260315000000',
    '<LANGUAGE>ENG',
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    bank,
    '</OFX>',
  ].join('\r\n');
}

describe('OFX Direct Connect protocol (0.11.1)', () => {
  it('formatOfxDateTime emits YYYYMMDDHHMMSS in UTC', () => {
    expect(formatOfxDateTime(new Date('2026-05-23T12:34:56Z'))).toBe(
      '20260523123456',
    );
  });

  it('buildOfxStmtRequest builds a CHECKING request with all required tags', () => {
    const body = buildOfxStmtRequest({
      connection: BASE_CONN,
      startDate: new Date('2026-03-01T00:00:00Z'),
      endDate: new Date('2026-03-15T00:00:00Z'),
    });
    expect(body).toContain('OFXHEADER:100');
    expect(body).toContain('VERSION:102');
    expect(body).toContain('<USERID>user@example.com');
    expect(body).toContain('<USERPASS>sup3r-s3cret');
    expect(body).toContain('<ORG>ExampleBank');
    expect(body).toContain('<FID>1001');
    expect(body).toContain('<APPID>QWIN');
    expect(body).toContain('<APPVER>2700');
    expect(body).toContain('<BANKID>021000021');
    expect(body).toContain('<ACCTID>000111222');
    expect(body).toContain('<ACCTTYPE>CHECKING');
    expect(body).toContain('<DTSTART>20260301000000');
    expect(body).toContain('<DTEND>20260315000000');
    expect(body).toContain('<INCLUDE>Y');
  });

  it('buildOfxStmtRequest builds a CREDITCARDMSGSRQV1 envelope for credit cards', () => {
    const cc = {
      ...BASE_CONN,
      bankAcctType: 'CREDITCARD' as const,
      bankId: null,
      bankAcctId: '4111111111111111',
    };
    const body = buildOfxStmtRequest({
      connection: cc,
      startDate: new Date('2026-03-01T00:00:00Z'),
      endDate: new Date('2026-03-15T00:00:00Z'),
    });
    expect(body).toContain('<CREDITCARDMSGSRQV1>');
    expect(body).not.toContain('<BANKACCTFROM>');
    expect(body).toContain('<CCACCTFROM>');
    expect(body).toContain('<ACCTID>4111111111111111');
  });

  it('buildOfxStmtRequest escapes SGML-significant characters in credentials', () => {
    const body = buildOfxStmtRequest({
      connection: { ...BASE_CONN, password: 'a&b<c>d' },
      startDate: new Date('2026-03-01T00:00:00Z'),
      endDate: new Date('2026-03-15T00:00:00Z'),
    });
    expect(body).toContain('<USERPASS>a&amp;b&lt;c&gt;d');
  });

  it('buildOfxStmtRequest emits INTU.BID when set', () => {
    const body = buildOfxStmtRequest({
      connection: { ...BASE_CONN, intuBid: '10898' },
      startDate: new Date('2026-03-01T00:00:00Z'),
      endDate: new Date('2026-03-15T00:00:00Z'),
    });
    expect(body).toContain('<INTU.BID>10898');
  });

  it('fetchOfxStatement parses a successful response into ParsedTransactions', async () => {
    const result = await fetchOfxStatement(
      {
        connection: BASE_CONN,
        startDate: new Date('2026-03-01T00:00:00Z'),
        endDate: new Date('2026-03-15T00:00:00Z'),
      },
      { fetchImpl: fakeFetchOk(okOfxResponse({ type: 'BANK' })) },
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.amountCents).toBe(-1234);
    expect(result.transactions[0]!.rawDescription).toBe('Test Merchant');
  });

  it('fetchOfxStatement throws auth_failed on SONRS 15500', async () => {
    const body = okOfxResponse({
      type: 'BANK',
      statusCode: 15500,
      message: 'Invalid signon',
    });
    await expect(
      fetchOfxStatement(
        {
          connection: BASE_CONN,
          startDate: new Date('2026-03-01T00:00:00Z'),
          endDate: new Date('2026-03-15T00:00:00Z'),
        },
        { fetchImpl: fakeFetchOk(body) },
      ),
    ).rejects.toMatchObject({ kind: 'auth_failed' });
  });

  it('fetchOfxStatement throws http_error when bank returns 500', async () => {
    const failing = (async () =>
      new Response('boom', { status: 500 })) as unknown as FetchLike;
    await expect(
      fetchOfxStatement(
        {
          connection: BASE_CONN,
          startDate: new Date('2026-03-01T00:00:00Z'),
          endDate: new Date('2026-03-15T00:00:00Z'),
        },
        { fetchImpl: failing },
      ),
    ).rejects.toMatchObject({ kind: 'http_error' });
  });

  it('fetchOfxStatement throws transport_error on fetch rejection', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchLike;
    await expect(
      fetchOfxStatement(
        {
          connection: BASE_CONN,
          startDate: new Date('2026-03-01T00:00:00Z'),
          endDate: new Date('2026-03-15T00:00:00Z'),
        },
        { fetchImpl: failing },
      ),
    ).rejects.toBeInstanceOf(OfxDcError);
  });
});
