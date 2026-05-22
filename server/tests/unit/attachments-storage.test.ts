import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
  AttachmentValidationError,
  sanitizeFilename,
  validateMimeType,
  validateSize,
} from '../../src/attachments/storage.js';

describe('sanitizeFilename', () => {
  it('strips directory components from a path-traversal filename', () => {
    expect(sanitizeFilename('../../etc/passwd.png')).toBe('passwd.png');
    expect(sanitizeFilename('C:\\Windows\\evil.png')).toBe('evil.png');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeFilename('my receipt (1).png')).toBe('my_receipt_1_.png');
  });

  it('keeps dots, dashes and underscores', () => {
    expect(sanitizeFilename('2026-05-14_starbucks.pdf')).toBe(
      '2026-05-14_starbucks.pdf',
    );
  });

  it('caps the result at 200 characters', () => {
    expect(sanitizeFilename('a'.repeat(500) + '.png').length).toBe(200);
  });

  it('falls back to "file" for empty / dot-only inputs', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('....')).toBe('file');
    expect(sanitizeFilename('/')).toBe('file');
  });
});

describe('validateMimeType', () => {
  it('accepts the allow-listed MIME types', () => {
    for (const t of ALLOWED_MIME_TYPES) {
      expect(() => validateMimeType(t)).not.toThrow();
    }
  });

  it('rejects everything else with an AttachmentValidationError', () => {
    expect(() => validateMimeType('application/octet-stream')).toThrow(
      AttachmentValidationError,
    );
    expect(() => validateMimeType('text/html')).toThrow(
      AttachmentValidationError,
    );
    expect(() => validateMimeType('image/svg+xml')).toThrow(
      AttachmentValidationError,
    );
  });
});

describe('validateSize', () => {
  it('rejects empty files', () => {
    expect(() => validateSize(0)).toThrow(AttachmentValidationError);
  });

  it('rejects oversized files', () => {
    expect(() => validateSize(MAX_FILE_BYTES + 1)).toThrow(
      AttachmentValidationError,
    );
  });

  it('accepts a small file', () => {
    expect(() => validateSize(1024)).not.toThrow();
  });

  it('accepts exactly the maximum', () => {
    expect(() => validateSize(MAX_FILE_BYTES)).not.toThrow();
  });
});
