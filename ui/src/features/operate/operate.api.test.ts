import { afterEach, describe, expect, it, vi } from 'vitest';
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
