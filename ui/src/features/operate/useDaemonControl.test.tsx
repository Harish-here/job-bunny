import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiError } from '../../lib/api/client';
import { wizardKeys } from '../wizard/wizard.queries';
import { useSetAutostart, useStartDaemon, useStopDaemon } from './useDaemonControl';

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

describe('useStopDaemon', () => {
  it('invalidates wizardKeys.daemon() on success — no optimistic write first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'stopped' })),
    );
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const setDataSpy = vi.spyOn(qc, 'setQueryData');
    const { result } = renderHook(() => useStopDaemon(), { wrapper: makeWrapper(qc) });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
    expect(setDataSpy).not.toHaveBeenCalled();
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
  it('invalidates the EXACT wizardKeys.daemon() key on success, reused not new', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'ok' })),
    );
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetAutostart(), { wrapper: makeWrapper(qc) });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
    expect(invalidateSpy.mock.calls[0]?.[0]?.queryKey).toEqual(['daemon']);
  });

  it('leaves a 409 autostart_conflict as a rejected mutation, not a fake outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: 'autostart_conflict', message: 'legacy plist present' },
        }),
      ),
    );
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetAutostart(), { wrapper: makeWrapper(qc) });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error as ApiError;
    expect(error.status).toBe(409);
    expect(error.code).toBe('autostart_conflict');
    expect(error.message).toBe('legacy plist present');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
