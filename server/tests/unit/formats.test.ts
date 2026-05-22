import { describe, it, expect } from 'vitest';
import {
  detectFormat,
  getFormat,
  listFormats,
  cleanDescription,
  buildGenericFormat,
} from '../../src/import/formats.js';

const CC_HEADERS = [
  'Transaction Date',
  'Post Date',
  'Description',
  'Category',
  'Type',
  'Amount',
  'Memo',
];
const BANK_HEADERS = [
  'Details',
  'Posting Date',
  'Description',
  'Amount',
  'Type',
  'Balance',
  'Check or Slip #',
];

describe('detectFormat', () => {
  it('detects the Chase credit-card layout', () => {
    expect(detectFormat(CC_HEADERS)?.id).toBe('chase_credit_card');
  });

  it('detects the Chase checking/savings layout', () => {
    expect(detectFormat(BANK_HEADERS)?.id).toBe('chase_bank');
  });

  it('is case-insensitive about header names', () => {
    expect(detectFormat(CC_HEADERS.map((h) => h.toLowerCase()))?.id).toBe(
      'chase_credit_card',
    );
  });

  it('returns undefined for an unknown layout', () => {
    expect(detectFormat(['Column A', 'Column B'])).toBeUndefined();
    expect(detectFormat([])).toBeUndefined();
  });
});

describe('listFormats / getFormat', () => {
  it('lists the built-in formats', () => {
    const ids = listFormats().map((f) => f.id);
    expect(ids).toContain('chase_credit_card');
    expect(ids).toContain('chase_bank');
  });

  it('looks up a format by id', () => {
    expect(getFormat('chase_bank')?.name).toMatch(/Chase/);
    expect(getFormat('does-not-exist')).toBeUndefined();
  });
});

describe('cleanDescription', () => {
  it('collapses runs of whitespace', () => {
    expect(cleanDescription('GROCERY MART      #123')).toBe(
      'GROCERY MART #123',
    );
    expect(cleanDescription('  leading and trailing  ')).toBe(
      'leading and trailing',
    );
    expect(cleanDescription('tabs\tand\nnewlines')).toBe(
      'tabs and newlines',
    );
  });

  it('handles undefined safely', () => {
    expect(cleanDescription(undefined)).toBe('');
  });
});

describe('chase_credit_card mapRow', () => {
  const format = getFormat('chase_credit_card')!;

  it('maps a row to a ParsedTransaction', () => {
    const result = format.mapRow({
      'Transaction Date': '05/14/2026',
      'Post Date': '05/15/2026',
      Description: 'COFFEE   SHOP',
      Category: 'Food & Drink',
      Type: 'Sale',
      Amount: '-4.50',
      Memo: '',
    });
    expect(result).toEqual({
      txnDate: '2026-05-14',
      postDate: '2026-05-15',
      amountCents: -450,
      rawDescription: 'COFFEE SHOP',
      sourceCategory: 'Food & Drink',
      sourceType: 'Sale',
      memo: null,
      balanceCents: null,
    });
  });
});

describe('chase_bank mapRow', () => {
  const format = getFormat('chase_bank')!;

  it('returns a null balance when the Balance cell is blank', () => {
    const result = format.mapRow({
      Details: 'DEBIT',
      'Posting Date': '05/22/2026',
      Description: 'ONLINE TRANSFER',
      Amount: '-100.00',
      Type: 'ACCT_XFER',
      Balance: ' ',
      'Check or Slip #': '',
    });
    expect(result.amountCents).toBe(-10000);
    expect(result.balanceCents).toBeNull();
  });

  it('parses a populated balance', () => {
    const result = format.mapRow({
      Details: 'CREDIT',
      'Posting Date': '05/22/2026',
      Description: 'PAYROLL',
      Amount: '2000.00',
      Type: 'ACH_CREDIT',
      Balance: '3400.00',
      'Check or Slip #': '',
    });
    expect(result.balanceCents).toBe(340000);
  });
});

describe('buildGenericFormat', () => {
  it('maps separate debit/credit columns to signed amounts', () => {
    const format = buildGenericFormat({
      txnDate: 'Date',
      description: 'Memo',
      debit: 'Withdrawal',
      credit: 'Deposit',
    });
    const debitRow = format.mapRow({
      Date: '05/20/2026',
      Memo: 'Bookstore',
      Withdrawal: '23.45',
      Deposit: '',
    });
    const creditRow = format.mapRow({
      Date: '05/18/2026',
      Memo: 'Paycheck',
      Withdrawal: '',
      Deposit: '1500.00',
    });
    expect(debitRow.amountCents).toBe(-2345);
    expect(creditRow.amountCents).toBe(150000);
  });

  it('maps a single signed amount column', () => {
    const format = buildGenericFormat({
      txnDate: 'Date',
      description: 'Memo',
      amount: 'Amount',
    });
    expect(
      format.mapRow({ Date: '05/20/2026', Memo: 'X', Amount: '-9.99' })
        .amountCents,
    ).toBe(-999);
  });
});
