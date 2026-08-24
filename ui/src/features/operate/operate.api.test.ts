import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { DoctorReport } from './operate.api';
import {
  getDoctorReport,
  pauseProfile,
  putSkipNext,
  setAutostart,
  startDaemon,
  stopDaemon,
} from './operate.api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDoctorReport', () => {
  it("hits '/api/profiles/:name/doctor' and returns the parsed report", async () => {
    const report: DoctorReport = { status: 'ok', findings: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, report));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getDoctorReport('rajni')).resolves.toEqual(report);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/doctor');
  });
});

describe('stopDaemon', () => {
  it("POSTs to '/api/daemon/stop' and returns the outcome", async () => {
    const outcome = { outcome: 'stopped' as const };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, outcome));
    vi.stubGlobal('fetch', fetchMock);
    await expect(stopDaemon()).resolves.toEqual(outcome);
    expect(fetchMock).toHaveBeenCalledWith('/api/daemon/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it("resolves (does not throw) on a 409 { outcome: 'daemon_unresponsive' } body", async () => {
    const outcome = { outcome: 'daemon_unresponsive' as const };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, outcome)));
    await expect(stopDaemon()).resolves.toEqual(outcome);
  });

  it(
    'resolves and preserves childPid on a 409 ' +
      "{ outcome: 'child_unresponsive', childPid } body",
    async () => {
      const outcome = { outcome: 'child_unresponsive' as const, childPid: 123 };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, outcome)));
      await expect(stopDaemon()).resolves.toEqual(outcome);
    },
  );

  it('still throws ApiError on a 409 body without a recognized outcome field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(409, { error: 'autostart_conflict' })),
    );
    const err = await stopDaemon().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'unknown' });
  });
});

describe('startDaemon', () => {
  it("POSTs to '/api/daemon/start' and returns the outcome", async () => {
    const outcome = { outcome: 'started' as const };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, outcome));
    vi.stubGlobal('fetch', fetchMock);
    await expect(startDaemon()).resolves.toEqual(outcome);
    expect(fetchMock).toHaveBeenCalledWith('/api/daemon/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it("resolves (does not throw) on a 500 { outcome: 'spawn_failed' } body", async () => {
    const outcome = { outcome: 'spawn_failed' as const };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, outcome)));
    await expect(startDaemon()).resolves.toEqual(outcome);
  });
});

describe('setAutostart', () => {
  it("PUTs { enabled } to '/api/daemon/autostart'", async () => {
    const outcome = { outcome: 'ok' as const };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, outcome));
    vi.stubGlobal('fetch', fetchMock);
    await expect(setAutostart(true)).resolves.toEqual(outcome);
    expect(fetchMock).toHaveBeenCalledWith('/api/daemon/autostart', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });

  it("still throws ApiError on a 409 'autostart_conflict' envelope", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: 'autostart_conflict', message: 'legacy plist present' },
        }),
      ),
    );
    const err = await setAutostart(true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'autostart_conflict' });
  });
});

describe('putSkipNext', () => {
  it('performs a GET then a PUT of profile.json with schedule.skipNext set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { text: '{"schedule":{"enabled":true,"times":["09:00"]}}' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await putSkipNext('rajni', true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/config/profile.json');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/profiles/rajni/config/profile.json');
    const putInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const sentBody = JSON.parse(putInit.body as string) as { text: string };
    expect(JSON.parse(sentBody.text)).toEqual({
      schedule: { enabled: true, times: ['09:00'], skipNext: true },
    });
  });
});

describe('pauseProfile', () => {
  it('performs a GET then a PUT of profile.json with schedule.enabled set false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { text: '{"schedule":{"enabled":true,"times":["09:00"]}}' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { text: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await pauseProfile('rajni');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/config/profile.json');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/profiles/rajni/config/profile.json');
    const putInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const sentBody = JSON.parse(putInit.body as string) as { text: string };
    expect(JSON.parse(sentBody.text)).toEqual({
      schedule: { enabled: false, times: ['09:00'] },
    });
  });
});
