import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardDetailResponse,
  BoardListResponse,
  TrackingRow,
} from '../../lib/api/types';
import { boardKeys } from './board.queries';
import { fieldPatch, useTrackingMutation } from './useTracking';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function detailResponse(tracking: TrackingRow | null): BoardDetailResponse {
  return { tracking } as unknown as BoardDetailResponse;
}

function listResponse(
  rows: { id: string; tracking: TrackingRow | null }[],
): BoardListResponse {
  return {
    rows,
    total: rows.length,
    limit: 50,
    offset: 0,
  } as unknown as BoardListResponse;
}

function stubFetchOk(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => ({ ok: true, json: async () => body }) as unknown,
    ) as unknown as typeof fetch,
  );
}

function stubFetchPending(): {
  resolve: (body: unknown) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (body: unknown) => void;
  let reject!: (err: unknown) => void;
  const pending = new Promise((res, rej) => {
    resolve = (body: unknown) => res({ ok: true, json: async () => body });
    reject = rej;
  });
  vi.stubGlobal('fetch', vi.fn(() => pending) as unknown as typeof fetch);
  return { resolve, reject };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useTrackingMutation', () => {
  it('optimistically writes the patched field into the detail cache before the fetch resolves', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(
      boardKeys.job('rajni', 'li-1'),
      detailResponse({ jobId: 'li-1', updatedAt: 't0', status: 'Applied' }),
    );
    const { resolve } = stubFetchPending();

    const { result } = renderHook(() => useTrackingMutation('rajni'), {
      wrapper: makeWrapper(qc),
    });

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.mutateAsync({
        jobId: 'li-1',
        patch: { status: 'Onsite' },
      });
    });

    await waitFor(() => {
      const cached = qc.getQueryData<BoardDetailResponse>(boardKeys.job('rajni', 'li-1'));
      expect(cached?.tracking?.status).toBe('Onsite');
    });

    resolve({ tracking: { jobId: 'li-1', updatedAt: 't1', status: 'Onsite' } });
    await promise;
  });

  it('replaces the optimistic row with the server row on success and invalidates the jobs prefix', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(
      boardKeys.job('rajni', 'li-1'),
      detailResponse({ jobId: 'li-1', updatedAt: 't0', status: 'Applied' }),
    );
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    stubFetchOk({ tracking: { jobId: 'li-1', updatedAt: 't1', status: 'Onsite' } });

    const { result } = renderHook(() => useTrackingMutation('rajni'), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ jobId: 'li-1', patch: { status: 'Onsite' } });
    });

    const cached = qc.getQueryData<BoardDetailResponse>(boardKeys.job('rajni', 'li-1'));
    expect(cached?.tracking).toEqual({
      jobId: 'li-1',
      updatedAt: 't1',
      status: 'Onsite',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: boardKeys.jobsPrefix('rajni'),
    });
  });

  it('rolls back only the patched field on failure, preserving a concurrently-updated field, and toasts', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(
      boardKeys.job('rajni', 'li-1'),
      detailResponse({
        jobId: 'li-1',
        updatedAt: 't0',
        status: 'Applied',
        notes: 'old notes',
      }),
    );
    const { reject } = stubFetchPending();

    const { result } = renderHook(() => useTrackingMutation('rajni'), {
      wrapper: makeWrapper(qc),
    });

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current
        .mutateAsync({ jobId: 'li-1', patch: { status: 'Onsite' } })
        .catch(() => undefined);
    });

    await waitFor(() => {
      const cached = qc.getQueryData<BoardDetailResponse>(boardKeys.job('rajni', 'li-1'));
      expect(cached?.tracking?.status).toBe('Onsite');
    });

    // A concurrent, already-confirmed edit lands on the row while this
    // PATCH is still in flight.
    qc.setQueryData<BoardDetailResponse>(boardKeys.job('rajni', 'li-1'), (d) =>
      d ? { ...d, tracking: { ...(d.tracking as TrackingRow), notes: 'new notes' } } : d,
    );

    reject(new Error('boom'));
    await promise;

    const cached = qc.getQueryData<BoardDetailResponse>(boardKeys.job('rajni', 'li-1'));
    expect(cached?.tracking).toEqual({
      jobId: 'li-1',
      updatedAt: 't0',
      status: 'Applied',
      notes: 'new notes',
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      'boom',
    );
  });

  it('optimistically patches + rolls back a jobsPrefix list row (no detail cache), preserving untouched fields', async () => {
    const qc = makeQueryClient();
    const seedRow: TrackingRow = {
      jobId: 'li-1',
      updatedAt: 't0',
      status: 'Applied',
      nextAction: 'call',
    };
    qc.setQueryData(
      boardKeys.jobs('rajni', {}),
      listResponse([{ id: 'li-1', tracking: seedRow }]),
    );
    const { reject } = stubFetchPending();

    const { result } = renderHook(() => useTrackingMutation('rajni'), {
      wrapper: makeWrapper(qc),
    });

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current
        .mutateAsync({ jobId: 'li-1', patch: { status: 'Onsite' } })
        .catch(() => undefined);
    });

    await waitFor(() => {
      const list = qc.getQueryData<BoardListResponse>(boardKeys.jobs('rajni', {}));
      const row = list?.rows.find((r) => r.id === 'li-1');
      expect((row?.tracking as TrackingRow)?.status).toBe('Onsite');
      expect((row?.tracking as TrackingRow)?.nextAction).toBe('call');
    });

    reject(new Error('boom'));
    await promise;

    const list = qc.getQueryData<BoardListResponse>(boardKeys.jobs('rajni', {}));
    const row = list?.rows.find((r) => r.id === 'li-1');
    expect(row?.tracking).toEqual(seedRow);
  });
});

describe('fieldPatch', () => {
  const row: TrackingRow = { jobId: 'li-1', updatedAt: 't0', notes: 'existing' };

  it('returns null when raw equals the current value', () => {
    expect(fieldPatch(row, 'notes', 'existing')).toBeNull();
  });

  it('treats an empty string and an absent field as unchanged', () => {
    expect(fieldPatch(null, 'notes', '')).toBeNull();
    expect(fieldPatch({ jobId: 'li-1', updatedAt: 't0' }, 'notes', '')).toBeNull();
  });

  it('clears a set field on whitespace-only input', () => {
    expect(fieldPatch(row, 'notes', '   ')).toEqual({ notes: null });
  });

  it('returns the trimmed string for a changed value', () => {
    expect(fieldPatch(row, 'notes', '  updated  ')).toEqual({ notes: 'updated' });
  });
});
