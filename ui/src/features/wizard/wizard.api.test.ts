import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { SEED_PROFILE_CONFIG } from './serialize';
import {
  getDaemonStatus,
  getPersonas,
  patchProfileConfig,
  putSecret,
  readProfileConfig,
  requestRunIntent,
  writeConfigDocText,
} from './wizard.api';
import type { DaemonStatus, PersonaCatalog, RunIntentView } from './wizard.types';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const INTENT: RunIntentView = {
  id: 7,
  requestedAt: '2026-08-07T09:00:00.000Z',
  status: 'pending',
  claimedRunId: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getPersonas', () => {
  it("hits '/api/personas' and returns the parsed catalog", async () => {
    const catalog: PersonaCatalog = { version: 1, personas: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, catalog));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getPersonas()).resolves.toEqual(catalog);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/personas');
  });
});

describe('getDaemonStatus', () => {
  it("hits '/api/daemon'", async () => {
    const status: DaemonStatus = {
      state: 'running',
      pid: 123,
      startedAt: '2026-08-07T00:00:00.000Z',
      lastTickAt: null,
      inFlight: null,
      profiles: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, status));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getDaemonStatus()).resolves.toEqual(status);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/daemon');
  });
});

describe('putSecret', () => {
  it('PUTs to /api/secrets/NOTION_TOKEN with the value in the body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { key: 'NOTION_TOKEN', status: 'present' }));
    vi.stubGlobal('fetch', fetchMock);
    await putSecret('NOTION_TOKEN', 'ntn_abc123');
    expect(fetchMock).toHaveBeenCalledWith('/api/secrets/NOTION_TOKEN', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'ntn_abc123' }),
    });
  });

  it('on a simulated 500 the thrown message does not contain the submitted value', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(500, { error: { code: 'unknown', message: 'internal error' } }),
        ),
    );
    const err = await putSecret('TELEGRAM_BOT_TOKEN', 'super-secret-token').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).not.toContain('super-secret-token');
  });
});

describe('readProfileConfig', () => {
  it('parses { text } into an object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { text: '{"connector":"sqlite"}' })),
    );
    await expect(readProfileConfig('rajni')).resolves.toEqual({ connector: 'sqlite' });
  });

  it('returns SEED_PROFILE_CONFIG when text is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { text: '' })));
    await expect(readProfileConfig('rajni')).resolves.toEqual(SEED_PROFILE_CONFIG);
  });

  it('returns SEED_PROFILE_CONFIG when text is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { text: 'not json' })),
    );
    await expect(readProfileConfig('rajni')).resolves.toEqual(SEED_PROFILE_CONFIG);
  });
});

describe('patchProfileConfig', () => {
  it('performs a GET then a PUT', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { text: '{"lanes":[],"connector":"sqlite"}' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await patchProfileConfig('rajni', (cfg) => {
      cfg.lanes = ['linkedin'];
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/config/profile.json');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/profiles/rajni/config/profile.json');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' });
  });

  it("the PUT body's text parses back to the mutated object", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { text: '{"lanes":[],"connector":"sqlite"}' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await patchProfileConfig('rajni', (cfg) => {
      cfg.lanes = ['linkedin', 'greenhouse'];
    });
    const putInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const sentBody = JSON.parse(putInit.body as string) as { text: string };
    expect(JSON.parse(sentBody.text)).toEqual({
      lanes: ['linkedin', 'greenhouse'],
      connector: 'sqlite',
    });
    expect(sentBody.text.endsWith('\n')).toBe(true);
  });

  it('mutating one key leaves the other keys intact', async () => {
    const existing = {
      lanes: ['linkedin'],
      connector: 'sqlite',
      notifiers: ['telegram'],
      settings: { notion: { mirror: true } },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { text: JSON.stringify(existing) }))
      .mockResolvedValueOnce(jsonResponse(200, { text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await patchProfileConfig('rajni', (cfg) => {
      (cfg.settings as Record<string, unknown>).telegram = { chatId: 12345 };
    });
    const putInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const sentBody = JSON.parse(putInit.body as string) as { text: string };
    expect(JSON.parse(sentBody.text)).toEqual({
      lanes: ['linkedin'],
      connector: 'sqlite',
      notifiers: ['telegram'],
      settings: { notion: { mirror: true }, telegram: { chatId: 12345 } },
    });
  });
});

describe('writeConfigDocText', () => {
  it('PUTs the given text to the document endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { text: '# Search URLs\n' }));
    vi.stubGlobal('fetch', fetchMock);
    await writeConfigDocText('rajni', 'search_urls.md', '# Search URLs\n');
    expect(fetchMock).toHaveBeenCalledWith('/api/profiles/rajni/config/search_urls.md', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '# Search URLs\n' }),
    });
  });
});

describe('requestRunIntent', () => {
  it('201 maps to queued with deduped:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(201, { intent: INTENT, deduped: false })),
    );
    await expect(requestRunIntent('rajni')).resolves.toEqual({
      kind: 'queued',
      intent: INTENT,
      deduped: false,
    });
  });

  it('200 maps to queued with deduped:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { intent: INTENT, deduped: true })),
    );
    await expect(requestRunIntent('rajni')).resolves.toEqual({
      kind: 'queued',
      intent: INTENT,
      deduped: true,
    });
  });

  it('409 with run_in_progress and a runId maps to run_in_progress carrying that id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: {
            code: 'run_in_progress',
            message: 'a run is already in progress',
            runId: 42,
          },
        }),
      ),
    );
    await expect(requestRunIntent('rajni')).resolves.toEqual({
      kind: 'run_in_progress',
      runId: 42,
    });
  });

  it('409 with a different code maps to error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: 'conflict', message: 'something else conflicted' },
        }),
      ),
    );
    await expect(requestRunIntent('rajni')).resolves.toEqual({
      kind: 'error',
      message: 'something else conflicted',
    });
  });

  it('500 maps to error with the envelope message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(500, { error: { code: 'unknown', message: 'boom' } }),
        ),
    );
    await expect(requestRunIntent('rajni')).resolves.toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  it("an unparseable body maps to error with 'HTTP 500'", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json', { status: 500 })),
    );
    await expect(requestRunIntent('rajni')).resolves.toEqual({
      kind: 'error',
      message: 'HTTP 500',
    });
  });
});

describe('profile-segment encoding', () => {
  it('encodes a profile name that needs escaping in every request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { text: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await readProfileConfig('my profile');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/profiles/my%20profile/config/profile.json',
    );

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse(201, { intent: INTENT, deduped: false }));
    await requestRunIntent('my profile');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/my%20profile/run-intents');
  });
});
