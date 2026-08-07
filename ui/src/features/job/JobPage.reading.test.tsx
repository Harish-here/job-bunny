import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/meta')) {
        return {
          ok: true,
          json: async () => ({
            statusOptions: ['Lead', 'Applied'],
            excitementOptions: [],
          }),
        } as unknown as Response;
      }
      if (url.includes('/jobs/')) {
        return { ok: true, json: async () => makeDetail() } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

function renderJobPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <JobPage profile="rajni" id="li-1" />
    </QueryClientProvider>,
  );
}

describe('JobPage reading width', () => {
  it('caps the left prose column at a comfortable reading width', async () => {
    stubFetch();
    renderJobPage();

    const heading = await screen.findByRole('heading', { name: 'Senior Engineer' });
    // Walk up from the job title to the reading column — the nearest
    // ancestor carrying the max-w-[72ch] cap that JobPage.tsx wraps
    // JobHeader + JdText in.
    let node: HTMLElement | null = heading;
    let found: HTMLElement | null = null;
    while (node) {
      if (node.className.includes('max-w-[72ch]')) {
        found = node;
        break;
      }
      node = node.parentElement;
    }
    expect(found).not.toBeNull();
    expect(found?.className).toContain('flex');
    expect(found?.className).toContain('w-full');
  });
});
