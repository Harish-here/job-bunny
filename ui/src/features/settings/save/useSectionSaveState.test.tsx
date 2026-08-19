import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../runs/runs.api';
import { useSectionSaveState } from './useSectionSaveState';

vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { Wrapper, qc };
}

// Waits until the underlying `useRunInFlight` query (keyed `[profile, 'runs',
// 'run-in-flight']`) has actually resolved, not merely been called — a bare
// "was the fetcher invoked" check races the promise settling.
async function waitForRunInFlightResolved(qc: QueryClient, profile: string) {
  await waitFor(() => {
    const state = qc.getQueryState([profile, 'runs', 'run-in-flight']);
    expect(state?.status).not.toBe('pending');
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSectionSaveState', () => {
  it('flips isDirty true when currentValue diverges from initialValue', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 1,
      offset: 0,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { Wrapper } = wrapper();
    const { result, rerender } = renderHook(
      ({ currentValue }) =>
        useSectionSaveState({
          profile: 'rajni',
          initialValue: { a: 1 },
          currentValue,
          validate: () => ({}),
          onSave,
        }),
      { wrapper: Wrapper, initialProps: { currentValue: { a: 1 } } },
    );
    expect(result.current.isDirty).toBe(false);
    rerender({ currentValue: { a: 2 } });
    expect(result.current.isDirty).toBe(true);
  });

  it('save() clears isDirty and sets successMessage once no run is in flight', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 1,
      offset: 0,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { Wrapper, qc } = wrapper();
    const { result, rerender } = renderHook(
      ({ currentValue }) =>
        useSectionSaveState({
          profile: 'rajni',
          initialValue: { a: 1 },
          currentValue,
          validate: () => ({}),
          onSave,
        }),
      { wrapper: Wrapper, initialProps: { currentValue: { a: 2 } } },
    );
    await waitForRunInFlightResolved(qc, 'rajni');
    expect(result.current.isDirty).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    expect(onSave).toHaveBeenCalledWith({ a: 2 });
    expect(result.current.successMessage).toBe(
      'Saved. Takes effect from your next run — nothing is running right now.',
    );
    // isDirty tracks initialValue vs currentValue, which the caller controls;
    // re-render with the same value the caller would settle on post-save.
    rerender({ currentValue: { a: 1 } });
    expect(result.current.isDirty).toBe(false);
  });

  it('sets the running-in-progress copy when a run is in flight at save time', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [{ id: 1, status: 'running' } as never],
      total: 1,
      limit: 1,
      offset: 0,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { Wrapper, qc } = wrapper();
    const { result } = renderHook(
      () =>
        useSectionSaveState({
          profile: 'rajni',
          initialValue: { a: 1 },
          currentValue: { a: 2 },
          validate: () => ({}),
          onSave,
        }),
      { wrapper: Wrapper },
    );
    await waitForRunInFlightResolved(qc, 'rajni');
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.successMessage).toBe(
      'Saved. A run is in progress; this applies to the next run, not that one.',
    );
  });

  it('a failing validate populates errors and never calls onSave', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 1,
      offset: 0,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { Wrapper } = wrapper();
    const { result } = renderHook(
      () =>
        useSectionSaveState({
          profile: 'rajni',
          initialValue: { a: 1 },
          currentValue: { a: 2 },
          validate: () => ({ a: 'must be 1' }),
          onSave,
        }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.errors).toEqual({ a: 'must be 1' });
    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.successMessage).toBeNull();
  });

  it('discard() clears successMessage and returns initialValue', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 1,
      offset: 0,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { Wrapper } = wrapper();
    const { result } = renderHook(
      () =>
        useSectionSaveState({
          profile: 'rajni',
          initialValue: { a: 1 },
          currentValue: { a: 2 },
          validate: () => ({}),
          onSave,
        }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.successMessage).not.toBeNull();
    let reverted: { a: number } | undefined;
    act(() => {
      reverted = result.current.discard();
    });
    expect(reverted).toEqual({ a: 1 });
    expect(result.current.successMessage).toBeNull();
  });
});
