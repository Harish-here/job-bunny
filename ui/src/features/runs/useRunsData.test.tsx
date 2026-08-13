import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as deferredSlotsApi from './deferredSlots.api';
import { useDeferredSlots } from './useRunsData';

vi.mock('./deferredSlots.api', () => ({ listDeferredSlots: vi.fn() }));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDeferredSlots', () => {
  it('resolves deferred slots data through React Query', async () => {
    vi.mocked(deferredSlotsApi.listDeferredSlots).mockResolvedValue({
      rows: [
        {
          runDate: '2026-08-13',
          slot: '10:00',
          reasonCode: 'host-asleep',
          reason: 'host is asleep',
          decidedAt: '2026-08-13T10:00:00Z',
          notifiedAt: null,
        },
      ],
      total: 1,
      date: '2026-08-13',
    });

    const { result } = renderHook(() => useDeferredSlots('rajni', '2026-08-13'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.rows).toHaveLength(1);
    expect(result.current.data?.total).toBe(1);
    expect(result.current.data?.date).toBe('2026-08-13');
  });

  it('resolves deferred slots data when date is omitted', async () => {
    vi.mocked(deferredSlotsApi.listDeferredSlots).mockResolvedValue({
      rows: [],
      total: 0,
      date: '2026-08-13',
    });

    const { result } = renderHook(() => useDeferredSlots('rajni'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.total).toBe(0);
    expect(result.current.data?.date).toBe('2026-08-13');
  });
});
