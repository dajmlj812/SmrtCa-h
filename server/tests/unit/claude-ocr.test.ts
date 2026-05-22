import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeOcrProvider } from '../../src/ocr/claude-ocr.js';

interface MessageBlock {
  type: 'text';
  text: string;
}

function fakeClient(jsonResponse: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: jsonResponse }] as MessageBlock[],
      })),
    },
  } as unknown as Anthropic;
}

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG magic bytes
const PDF_BUFFER = Buffer.from('%PDF-1.4');

describe('ClaudeOcrProvider', () => {
  it('builds an image content block for an image MIME type', async () => {
    const client = fakeClient(
      JSON.stringify({
        amountCents: 1234,
        date: '2026-05-14',
        merchant: 'Starbucks',
        confidence: 0.9,
        note: '',
      }),
    );
    const provider = new ClaudeOcrProvider({ apiKey: 'k', client });
    await provider.extract({
      buffer: PNG_BUFFER,
      mimeType: 'image/png',
      filename: 'receipt.png',
    });

    const createMock = (
      client.messages as unknown as { create: ReturnType<typeof vi.fn> }
    ).create;
    const arg = createMock.mock.calls[0]![0] as {
      model: string;
      system: string;
      messages: Array<{
        content: Array<{ type: string; source?: { media_type?: string } }>;
      }>;
    };
    expect(arg.model).toBe('claude-haiku-4-5');
    expect(arg.messages[0]!.content[0]!.type).toBe('image');
    expect(arg.messages[0]!.content[0]!.source?.media_type).toBe('image/png');
  });

  it('builds a document content block for a PDF', async () => {
    const client = fakeClient(
      JSON.stringify({
        amountCents: 5000,
        date: '2026-05-14',
        merchant: 'Walmart',
        confidence: 0.85,
        note: '',
      }),
    );
    const provider = new ClaudeOcrProvider({ apiKey: 'k', client });
    await provider.extract({
      buffer: PDF_BUFFER,
      mimeType: 'application/pdf',
      filename: 'receipt.pdf',
    });

    const createMock = (
      client.messages as unknown as { create: ReturnType<typeof vi.fn> }
    ).create;
    const arg = createMock.mock.calls[0]![0] as {
      messages: Array<{
        content: Array<{ type: string; source?: { media_type?: string } }>;
      }>;
    };
    expect(arg.messages[0]!.content[0]!.type).toBe('document');
    expect(arg.messages[0]!.content[0]!.source?.media_type).toBe(
      'application/pdf',
    );
  });

  it('parses and sanitizes the response', async () => {
    const client = fakeClient(
      JSON.stringify({
        amountCents: 1234,
        date: '2026-05-14',
        merchant: '  T-Mobile  ',
        confidence: 5,
        note: 'subtotal only',
      }),
    );
    const provider = new ClaudeOcrProvider({ apiKey: 'k', client });
    const result = await provider.extract({
      buffer: PNG_BUFFER,
      mimeType: 'image/png',
      filename: 'r.png',
    });

    expect(result.amountCents).toBe(1234);
    expect(result.date).toBe('2026-05-14');
    expect(result.merchant).toBe('T-Mobile');
    expect(result.confidence).toBe(1); // clamped from 5
    expect(result.note).toBe('subtotal only');
  });

  it('returns a sanitized null-shaped result when the model returns nulls', async () => {
    const client = fakeClient(
      JSON.stringify({
        amountCents: null,
        date: null,
        merchant: null,
        confidence: 0.2,
        note: 'blurry receipt',
      }),
    );
    const provider = new ClaudeOcrProvider({ apiKey: 'k', client });
    const result = await provider.extract({
      buffer: PNG_BUFFER,
      mimeType: 'image/png',
      filename: 'r.png',
    });

    expect(result.amountCents).toBeNull();
    expect(result.date).toBeNull();
    expect(result.merchant).toBeNull();
    expect(result.confidence).toBe(0.2);
    expect(result.note).toBe('blurry receipt');
  });

  it('throws on an unsupported MIME type', async () => {
    const client = fakeClient('{}');
    const provider = new ClaudeOcrProvider({ apiKey: 'k', client });
    await expect(
      provider.extract({
        buffer: Buffer.from('garbage'),
        mimeType: 'application/octet-stream',
        filename: 'oops.bin',
      }),
    ).rejects.toThrow(/Claude OCR cannot process MIME type/);
  });

  it('rethrows a clearer error when the SDK throws', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => Promise.reject(new Error('boom'))),
      },
    } as unknown as Anthropic;
    const provider = new ClaudeOcrProvider({ apiKey: 'k', client });
    await expect(
      provider.extract({
        buffer: PNG_BUFFER,
        mimeType: 'image/png',
        filename: 'r.png',
      }),
    ).rejects.toThrow(/boom/);
  });

  it('refuses to construct without an API key or injected client', () => {
    expect(() => new ClaudeOcrProvider({ apiKey: '' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
