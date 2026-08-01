import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJob, getMeta, listJobs, patchTracking } from './api';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(okJson({}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('board api paths', () => {
  it('listJobs builds the jobs URL with query string', async () => {
    const fetchMock = stubFetch();
    await listJobs('rajni', { status: 'Applied', limit: 50, offset: 0 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/profiles/rajni/jobs?status=Applied&limit=50&offset=0',
    );
  });

  it('encodes the profile and job id path segments', async () => {
    const fetchMock = stubFetch();
    await getJob('we ird', 'li-a/b');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/we%20ird/jobs/li-a%2Fb');
  });

  it('patchTracking targets the tracking route with PATCH', async () => {
    const fetchMock = stubFetch();
    await patchTracking('rajni', 'li-1', { status: 'Applied' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/jobs/li-1/tracking');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('getMeta targets the meta route', async () => {
    const fetchMock = stubFetch();
    await getMeta('rajni');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/meta');
  });
});
