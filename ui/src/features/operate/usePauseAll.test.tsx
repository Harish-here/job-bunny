import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as profilesApi from '../shell/profiles.api';
import * as operateApi from './operate.api';
import { usePauseAll } from './usePauseAll';

vi.mock('../shell/profiles.api', () => ({
  getProfiles: vi.fn(),
}));

vi.mock('./operate.api', () => ({
  pauseProfile: vi.fn(),
}));

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

afterEach(() => {
  vi.clearAllMocks();
});

describe('usePauseAll', () => {
  it('surfaces exactly the 2 failing profiles under `failed`, the rest under `succeeded`', async () => {
    vi.mocked(profilesApi.getProfiles).mockResolvedValue({
      profiles: [
        { name: 'alpha', connector: 'sqlite', hasDb: true },
        { name: 'beta', connector: 'sqlite', hasDb: true },
        { name: 'gamma', connector: 'sqlite', hasDb: true },
        { name: 'delta', connector: 'sqlite', hasDb: true },
      ],
    });
    vi.mocked(operateApi.pauseProfile).mockImplementation(async (profile: string) => {
      if (profile === 'beta') throw new Error('beta write failed');
      if (profile === 'delta') throw new Error('delta write failed');
    });

    const qc = makeQueryClient();
    const { result } = renderHook(() => usePauseAll(), { wrapper: makeWrapper(qc) });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.succeeded).toEqual(['alpha', 'gamma']);
    expect(result.current.data?.failed).toEqual([
      { profile: 'beta', message: 'beta write failed' },
      { profile: 'delta', message: 'delta write failed' },
    ]);
  });

  it('does not abort the fan-out when every profile fails (allSettled, not all)', async () => {
    vi.mocked(profilesApi.getProfiles).mockResolvedValue({
      profiles: [
        { name: 'alpha', connector: 'sqlite', hasDb: true },
        { name: 'beta', connector: 'sqlite', hasDb: true },
      ],
    });
    vi.mocked(operateApi.pauseProfile).mockRejectedValue(new Error('boom'));

    const qc = makeQueryClient();
    const { result } = renderHook(() => usePauseAll(), { wrapper: makeWrapper(qc) });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.succeeded).toEqual([]);
    expect(result.current.data?.failed).toEqual([
      { profile: 'alpha', message: 'boom' },
      { profile: 'beta', message: 'boom' },
    ]);
  });
});
