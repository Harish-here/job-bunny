import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardJobDetail } from '../../lib/api/types';
import { JobPage } from './JobPage';

beforeAll(() => {
  // radix Select (inside TrackingPanel) needs these in jsdom.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

function makeDetail(): BoardJobDetail {
  return {
    id: 'li-1',
    lane: 'linkedin',
    title: 'Senior Engineer',
    company: 'Acme',
    url: 'https://acme.example/jobs/1',
    seniority: 'Senior',
    locationCity: 'Remote',
    workType: 'remote',
    timezone: 'IST',
    skills: [],
    excitement: null,
    score: 88,
    matchReasons: [],
    reviewFlags: [],
    dateFound: '2026-08-01T00:00:00.000Z',
    archived: false,
    tracking: null,
    jd: {
      identity: {
        id: 'li-1',
        lane: 'linkedin',
        url: 'https://acme.example/jobs/1',
        company: 'Acme',
        title: 'Senior Engineer',
        scrapedAt: '2026-08-01T00:00:00.000Z',
      },
      content: { rawText: 'We are hiring a senior engineer.' },
    },
  };
}

function stubFetch(opts: { notFound?: boolean } = {}) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/meta')) {
      return {
        ok: true,
        json: async () => ({ statusOptions: ['Lead', 'Applied'], excitementOptions: [] }),
      } as unknown as Response;
    }
    if (url.includes('/jobs/')) {
      if (opts.notFound) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { code: 'not_found', message: 'no such job' } }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => makeDetail() } as unknown as Response;
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
  vi.stubGlobal('fetch', impl as unknown as typeof fetch);
  return impl;
}

function renderJobPage(id = 'li-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <JobPage profile="rajni" id={id} />
    </QueryClientProvider>,
  );
}

describe('JobPage', () => {
  it('renders the job title and the tracking panel from the fetched detail', async () => {
    stubFetch();
    renderJobPage();

    expect(await screen.findByText('Senior Engineer')).toBeInTheDocument();
    expect(screen.getByText('Tracking')).toBeInTheDocument();
    expect(screen.getByText(/We are hiring a senior engineer/)).toBeInTheDocument();
  });

  it('falls back to #/triage on back when there is no browser history to go back to', async () => {
    stubFetch();
    Object.defineProperty(window.history, 'length', { value: 1, configurable: true });
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    renderJobPage();

    await screen.findByText('Senior Engineer');
    await userEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/triage');
  });

  it('renders a "job not found" state for a 404', async () => {
    stubFetch({ notFound: true });
    renderJobPage();

    expect(await screen.findByText('Job not found.')).toBeInTheDocument();
  });
});
