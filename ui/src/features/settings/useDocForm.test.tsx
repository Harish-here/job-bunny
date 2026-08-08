import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from './config.api';
import { useDocForm } from './useDocForm';

vi.mock('./config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDocForm', () => {
  it('parses a valid JSON doc into `value`, and treats an empty doc as `{}`, not a parse error', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: '{"connector":"sqlite"}',
    });
    const { result } = renderHook(() => useDocForm('rajni', 'profile.json'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.value).toEqual({ connector: 'sqlite' }));
    expect(result.current.parseError).toBe(false);
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '' });
    const empty = renderHook(() => useDocForm('rajni', 'filter.json'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(empty.result.current.isLoading).toBe(false));
    expect(empty.result.current.value).toEqual({});
    expect(empty.result.current.parseError).toBe(false);

    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '{not json' });
    const bad = renderHook(() => useDocForm('rajni', 'filter.json'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(bad.result.current.parseError).toBe(true));
    expect(bad.result.current.value).toBeNull();
  });

  it('save() re-parses the current text, applies the mutation, PUTs the merged doc, and preserves unrelated keys', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: '{"connector":"sqlite","lanes":["linkedin"],"settings":{"rank":{"maxPoints":40}}}',
    });
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const { result } = renderHook(() => useDocForm('rajni', 'profile.json'), {
      wrapper: wrapper(),
    });
    // Wait on `isLoading`, not `value` — an unloaded doc's `value` is
    // already `{}` (non-null) from the very first render, so a `.not
    // .toBeNull()` wait would pass trivially before the real load lands.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let ok = false;
    await act(async () => {
      ok = await result.current.save((value) => {
        value.connector = 'notion';
      });
    });
    expect(ok).toBe(true);
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(call[0]).toBe('rajni');
    expect(call[1]).toBe('profile.json');
    expect(JSON.parse(call[2])).toEqual({
      connector: 'notion',
      lanes: ['linkedin'],
      settings: { rank: { maxPoints: 40 } },
    });
    expect(call[2].endsWith('\n')).toBe(true);
  });

  it('exposes a loadError when the GET fails, and save() refuses without ever PUTting a blank base', async () => {
    vi.mocked(configApi.getConfigDoc).mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useDocForm('rajni', 'filter.json'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.loadError?.message).toBe('network error'));
    // `isLoading` never clears on a rejected GET — `syncedFor` is only set
    // by the success effect — so save() must refuse via that same signal.
    expect(result.current.isLoading).toBe(true);

    let ok = true;
    await act(async () => {
      ok = await result.current.save((value) => {
        value.locations = [];
      });
    });
    expect(ok).toBe(false);
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
    expect(result.current.serverError).toMatch(/hasn't finished loading/);
  });

  it('save() returns false and surfaces the message when the PUT is rejected', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: '{"connector":"sqlite"}',
    });
    vi.mocked(configApi.putConfigDoc).mockRejectedValue(
      new Error('profile.json is invalid: connector is required'),
    );
    const { result } = renderHook(() => useDocForm('rajni', 'profile.json'), {
      wrapper: wrapper(),
    });
    // Wait on `isLoading`, not `value` — an unloaded doc's `value` is
    // already `{}` (non-null) from the very first render, so a `.not
    // .toBeNull()` wait would pass trivially before the real load lands.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let ok = true;
    await act(async () => {
      ok = await result.current.save((value) => {
        value.connector = '';
      });
    });
    expect(ok).toBe(false);
    await waitFor(() =>
      expect(result.current.serverError).toBe(
        'profile.json is invalid: connector is required',
      ),
    );
  });
});
