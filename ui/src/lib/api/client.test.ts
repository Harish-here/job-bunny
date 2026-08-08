import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  buildQuery,
  deleteJson,
  getJson,
  patchJson,
  postJson,
  putJson,
} from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildQuery', () => {
  it('serializes defined params and skips undefined/empty', () => {
    expect(
      buildQuery({
        status: 'Applied',
        company: undefined,
        offset: 0,
        sort: 'score',
        empty: '',
      }),
    ).toBe('?status=Applied&offset=0&sort=score');
  });

  it('returns empty string when nothing survives', () => {
    expect(buildQuery({ a: undefined, b: '' })).toBe('');
  });

  it('percent-encodes values', () => {
    expect(buildQuery({ company: 'a&b c' })).toBe('?company=a%26b+c');
  });
});

describe('getJson', () => {
  it('returns the parsed body on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { rows: [], total: 0 })),
    );
    await expect(getJson('/api/x')).resolves.toEqual({ rows: [], total: 0 });
  });

  it('throws ApiError with envelope code/message on API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          error: { code: 'no_local_db', message: 'profile has no local database' },
        }),
      ),
    );
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'no_local_db' });
  });

  it('throws ApiError(code unknown) when an error body is not the envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })),
    );
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, code: 'unknown', message: 'HTTP 500' });
  });

  it('throws ApiError(code bad_response) on a 200 with a non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })),
    );
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 200, code: 'bad_response' });
  });

  it('wraps network failures as ApiError(status 0, code network)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });
});

describe('patchJson', () => {
  it('sends PATCH with json content-type and body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { tracking: { jobId: 'li-1', updatedAt: 'x' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await patchJson('/api/x', { status: 'Applied' });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Applied' }),
    });
  });
});

describe('putJson', () => {
  it('sends PUT with json content-type and body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { text: 'hi' }));
    vi.stubGlobal('fetch', fetchMock);
    await putJson('/api/x', { text: 'hi' });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
  });
});

describe('postJson', () => {
  it('sends POST with json content-type and body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(201, { profile: { name: 'x', connector: 'sqlite', hasDb: true } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await postJson('/api/profiles', { name: 'x' });
    expect(fetchMock).toHaveBeenCalledWith('/api/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
  });
});

describe('deleteJson', () => {
  it('sends DELETE with no body and no headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { intent: { id: 3 } }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteJson('/api/x');
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { method: 'DELETE' });
  });

  it('throws ApiError with the envelope code/message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: 'intent_not_pending', message: 'intent is no longer pending' },
        }),
      ),
    );
    const err = await deleteJson('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'intent_not_pending' });
  });
});
