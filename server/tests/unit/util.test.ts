import { describe, it, expect } from 'vitest';
import { isUuid } from '../../src/util.js';

describe('isUuid', () => {
  it('accepts well-formed UUIDs', () => {
    expect(isUuid('24ad4bc7-9392-4d33-b463-1c84e445ded3')).toBe(true);
    expect(isUuid('24AD4BC7-9392-4D33-B463-1C84E445DED3')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('24ad4bc7-9392-4d33-b463')).toBe(false);
    expect(isUuid('24ad4bc7_9392_4d33_b463_1c84e445ded3')).toBe(false);
    expect(isUuid("'; DROP TABLE accounts; --")).toBe(false);
  });
});
