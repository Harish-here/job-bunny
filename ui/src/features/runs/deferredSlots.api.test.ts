import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDeferredSlots } from './deferredSlots.api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listDeferredSlots', () => {
  it('includes the date query param when provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { rows: [], total: 0, date: '2026-08-12' }));
    vi.stubGlobal('fetch', fetchMock);
    await listDeferredSlots('rajni', '2026-08-12');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/profiles/rajni/deferred-slots?date=2026-08-12',
    );
  });

  it('omits the query string entirely when date is not provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { rows: [], total: 0, date: '2026-08-13' }));
    vi.stubGlobal('fetch', fetchMock);
    await listDeferredSlots('rajni');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/deferred-slots');
  });
});
