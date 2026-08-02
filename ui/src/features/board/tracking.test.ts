import { describe, expect, it } from 'vitest';
import type { TrackingRow } from '../../lib/api/types';
import { applyPatch } from './tracking';

const existing: TrackingRow = {
  jobId: 'li-1',
  updatedAt: '2026-08-01T10:00:00.000Z',
  status: 'Applied',
  notes: 'phone screen booked',
};

describe('applyPatch', () => {
  it('creates a fresh row from null with empty updatedAt', () => {
    expect(applyPatch(null, 'li-9', { status: 'Lead' })).toEqual({
      jobId: 'li-9',
      updatedAt: '',
      status: 'Lead',
    });
  });

  it('overwrites patched fields and keeps the rest', () => {
    const next = applyPatch(existing, 'li-1', { status: 'Onsite' });
    expect(next).toEqual({ ...existing, status: 'Onsite' });
  });

  it('null clears a field entirely', () => {
    const next = applyPatch(existing, 'li-1', { notes: null });
    expect(next).toEqual({
      jobId: 'li-1',
      updatedAt: '2026-08-01T10:00:00.000Z',
      status: 'Applied',
    });
    expect('notes' in next).toBe(false);
  });

  it('does not mutate the input row', () => {
    applyPatch(existing, 'li-1', { status: 'Rejected', notes: null });
    expect(existing.status).toBe('Applied');
    expect(existing.notes).toBe('phone screen booked');
  });
});
