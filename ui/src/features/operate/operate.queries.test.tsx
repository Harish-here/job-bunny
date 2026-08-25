import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wizardKeys } from '../wizard/wizard.queries';
import {
  doctorQuery,
  operateKeys,
  usePutSkipNext,
  useSetScheduleEnabled,
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
    result.current.mutate({ date: '2026-08-24', slot: '09:00' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
  });
});

describe('useSetScheduleEnabled', () => {
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
    const { result } = renderHook(() => useSetScheduleEnabled('rajni'), {
      wrapper: makeWrapper(qc),
    });
    result.current.mutate(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: wizardKeys.daemon() });
  });
});
