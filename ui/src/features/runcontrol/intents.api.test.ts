import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { RunIntentView } from '../wizard/wizard.types';
import { cancelRunIntent, listRunIntents } from './intents.api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ROW: RunIntentView = {
  id: 3,
  requestedAt: '2026-08-08T09:00:00.000Z',
  status: 'pending',
  claimedRunId: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listRunIntents', () => {
  it("GETs '/api/profiles/:name/run-intents' and returns the rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { rows: [ROW] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listRunIntents('rajni')).resolves.toEqual({ rows: [ROW] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/run-intents');
  });

  it('encodes a profile name that needs escaping', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await listRunIntents('my profile');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/my%20profile/run-intents');
  });

  it('throws ApiError with the envelope code on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { code: 'no_such_profile', message: 'no such profile' },
        }),
      ),
    );
    const err = await listRunIntents('ghost').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'no_such_profile' });
  });
});

describe('cancelRunIntent', () => {
  it("DELETEs '/api/profiles/:name/run-intents/:id'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { intent: ROW }));
    vi.stubGlobal('fetch', fetchMock);
    await cancelRunIntent('rajni', 3);
    expect(fetchMock).toHaveBeenCalledWith('/api/profiles/rajni/run-intents/3', {
      method: 'DELETE',
    });
  });

  it('throws ApiError with the envelope code on a 409 conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: 'intent_not_pending', message: 'intent is no longer pending' },
        }),
      ),
    );
    const err = await cancelRunIntent('rajni', 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'intent_not_pending' });
  });
});
