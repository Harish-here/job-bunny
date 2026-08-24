import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wizardKeys } from '../wizard/wizard.queries';
import {
  doctorQuery,
  operateKeys,
  usePutSkipNext,
  useSetAutostart,
  useStartDaemon,
  useStopDaemon,
} from './operate.queries';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
  vi.unstubAllGlobals();
});

describe('doctorQuery', () => {
  it('keys on [profile, "doctor"] and is disabled for an empty profile', () => {
    const opts = doctorQuery('rajni');
    expect(opts.queryKey).toEqual(operateKeys.doctor('rajni'));
    expect(doctorQuery('').enabled).toBe(false);
  });
});

describe('useStopDaemon', () => {
  it('invalidates wizardKeys.daemon() on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'stopped' })),
    );
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useStopDaemon(), { wrapper: makeWrapper(qc) });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
  });
});

describe('useStartDaemon', () => {
  it('invalidates wizardKeys.daemon() on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'started' })),
    );
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useStartDaemon(), { wrapper: makeWrapper(qc) });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
  });
});

describe('useSetAutostart', () => {
  it('invalidates wizardKeys.daemon() on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'ok' })),
    );
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetAutostart(), { wrapper: makeWrapper(qc) });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
  });
});

describe('usePutSkipNext', () => {
  it('invalidates wizardKeys.daemon() on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { text: '{"schedule":{}}' }))
        .mockResolvedValueOnce(jsonResponse(200, { text: 'ok' })),
    );
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePutSkipNext('rajni'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
  });
});
