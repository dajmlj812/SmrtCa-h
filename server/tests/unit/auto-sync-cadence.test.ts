import { describe, it, expect } from 'vitest';
import { shouldRunForSource } from '../../src/domain/auto-sync.js';

describe('shouldRunForSource (0.11.3)', () => {
  const now = new Date('2026-05-23T12:00:00Z');

  it('NULL last_sync_at always runs', () => {
    expect(shouldRunForSource(null, 'hourly', now)).toBe(true);
    expect(shouldRunForSource(null, 'daily', now)).toBe(true);
    expect(shouldRunForSource(null, 'weekly', now)).toBe(true);
  });

  it('hourly cadence — runs when last sync was 65 minutes ago', () => {
    const last = new Date(now.getTime() - 65 * 60 * 1000);
    expect(shouldRunForSource(last, 'hourly', now)).toBe(true);
  });

  it('hourly cadence — skips when last sync was 30 minutes ago', () => {
    const last = new Date(now.getTime() - 30 * 60 * 1000);
    expect(shouldRunForSource(last, 'hourly', now)).toBe(false);
  });

  it('hourly cadence — tolerates jitter (just under 60 min counts)', () => {
    const last = new Date(now.getTime() - 59.5 * 60 * 1000);
    expect(shouldRunForSource(last, 'hourly', now)).toBe(true);
  });

  it('daily cadence — runs after 23 hours', () => {
    const last = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(shouldRunForSource(last, 'daily', now)).toBe(true);
    const recent = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    expect(shouldRunForSource(recent, 'daily', now)).toBe(false);
  });

  it('weekly cadence — runs after 6 days', () => {
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(shouldRunForSource(lastWeek, 'weekly', now)).toBe(true);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(shouldRunForSource(yesterday, 'weekly', now)).toBe(false);
  });

  it('unknown frequency defaults to daily', () => {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(shouldRunForSource(yesterday, 'whatever', now)).toBe(true);
  });
});
