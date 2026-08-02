import { describe, expect, it, vi } from 'vitest';
import type { TrackingPatchBody, TrackingRow } from '../../lib/api/types';
import { applyPatch, commitField } from './tracking';

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

describe('commitField', () => {
  it('optimistically applies before the server resolves, then applies the confirmed row', async () => {
    let row: TrackingRow | null = { jobId: 'li-1', updatedAt: 't0', status: 'Applied' };
    const applied: (TrackingRow | null)[] = [];
    let resolvePatch!: (value: TrackingRow) => void;
    const pending = new Promise<TrackingRow>((resolve) => {
      resolvePatch = resolve;
    });
    const patch = vi.fn(() => pending);
    const deps = {
      read: () => row,
      patch,
      apply: (t: TrackingRow | null) => {
        row = t;
        applied.push(t);
      },
    };

    const promise = commitField('li-1', 'status', 'Onsite', deps);

    // The optimistic apply runs synchronously before the awaited patch(),
    // so it's already visible even though the promise above hasn't settled.
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({ jobId: 'li-1', updatedAt: 't0', status: 'Onsite' });

    const serverRow: TrackingRow = { jobId: 'li-1', updatedAt: 't1', status: 'Onsite' };
    resolvePatch(serverRow);
    const result = await promise;

    expect(result).toBeNull();
    expect(applied).toHaveLength(2);
    expect(applied[1]).toEqual(serverRow);
    expect(row).toEqual(serverRow);
  });

  it('is a no-op when raw equals the current value', async () => {
    let row: TrackingRow | null = { jobId: 'li-1', updatedAt: 't0', status: 'Applied' };
    const applied: (TrackingRow | null)[] = [];
    const patch = vi.fn();
    const deps = {
      read: () => row,
      patch,
      apply: (t: TrackingRow | null) => {
        row = t;
        applied.push(t);
      },
    };

    const result = await commitField('li-1', 'status', 'Applied', deps);

    expect(result).toBeNull();
    expect(applied).toHaveLength(0);
    expect(patch).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty string on an absent field', async () => {
    let row: TrackingRow | null = { jobId: 'li-1', updatedAt: 't0' };
    const applied: (TrackingRow | null)[] = [];
    const patch = vi.fn();
    const deps = {
      read: () => row,
      patch,
      apply: (t: TrackingRow | null) => {
        row = t;
        applied.push(t);
      },
    };

    const result = await commitField('li-1', 'notes', '', deps);

    expect(result).toBeNull();
    expect(applied).toHaveLength(0);
    expect(patch).not.toHaveBeenCalled();
  });

  it('sends a null patch and optimistically clears a present field on empty string', async () => {
    let row: TrackingRow | null = { jobId: 'li-1', updatedAt: 't0', notes: 'old' };
    const applied: (TrackingRow | null)[] = [];
    const serverRow: TrackingRow = { jobId: 'li-1', updatedAt: 't1' };
    const patch = vi.fn(async (p: TrackingPatchBody) => {
      expect(p).toEqual({ notes: null });
      return serverRow;
    });
    const deps = {
      read: () => row,
      patch,
      apply: (t: TrackingRow | null) => {
        row = t;
        applied.push(t);
      },
    };

    const result = await commitField('li-1', 'notes', '', deps);

    expect(result).toBeNull();
    expect(patch).toHaveBeenCalledWith({ notes: null });
    expect(applied[0]).toEqual({ jobId: 'li-1', updatedAt: 't0' });
    expect('notes' in applied[0]!).toBe(false);
    expect(row).toEqual(serverRow);
  });

  it('rolls back only the field it owns, preserving a concurrent confirmed edit', async () => {
    let row: TrackingRow | null = { jobId: 'li-1', updatedAt: 't0', notes: 'old' };
    const patch = vi.fn(async () => {
      // Simulate a concurrent, already-confirmed status edit landing on the
      // row while this notes PATCH is still in flight.
      row = { ...row!, status: 'Applied', notes: 'new', updatedAt: 't1' };
      throw new Error('boom');
    });
    const deps = {
      read: () => row,
      patch,
      apply: (t: TrackingRow | null) => {
        row = t;
      },
    };

    const result = await commitField('li-1', 'notes', 'new', deps);

    expect(result).toBe('boom');
    expect(row).toEqual({
      jobId: 'li-1',
      updatedAt: 't1',
      status: 'Applied',
      notes: 'old',
    });
  });

  it('rolls back to absent (deleted key) when a previously-absent field fails', async () => {
    let row: TrackingRow | null = { jobId: 'li-1', updatedAt: 't0' };
    const patch = vi.fn(async () => {
      throw new Error('nope');
    });
    const deps = {
      read: () => row,
      patch,
      apply: (t: TrackingRow | null) => {
        row = t;
      },
    };

    const result = await commitField('li-1', 'notes', 'new', deps);

    expect(result).toBe('nope');
    expect(row).toEqual({ jobId: 'li-1', updatedAt: 't0' });
    expect('notes' in (row as object)).toBe(false);
  });
});
