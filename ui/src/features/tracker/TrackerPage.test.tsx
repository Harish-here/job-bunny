import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardJobRow } from '../../lib/api/types';
import { TrackerPage } from './TrackerPage';

beforeAll(() => {
  // radix Select + our own scrollIntoView-on-focus need these in jsdom.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROWS: BoardJobRow[] = [
  {
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
    tracking: {
      jobId: 'li-1',
      updatedAt: 't0',
      status: 'Applied',
      nextAction: 'follow up',
      nextActionDate: '2026-07-30', // overdue vs the stubbed "today" below
    },
  },
  {
    id: 'li-2',
    lane: 'linkedin',
    title: 'Product Manager',
    company: 'Beta',
    url: 'https://beta.example/jobs/2',
    seniority: null,
    locationCity: 'Bengaluru',
    workType: 'hybrid',
    timezone: null,
    skills: [],
    excitement: null,
    score: 60,
    matchReasons: [],
    reviewFlags: [],
    dateFound: '2026-07-30T00:00:00.000Z',
    archived: false,
    tracking: { jobId: 'li-2', updatedAt: 't0', status: 'Lead' },
  },
  {
    id: 'li-3',
    lane: 'linkedin',
    title: 'Undecided Role',
    company: 'Gamma',
    url: 'https://gamma.example/jobs/3',
    seniority: null,
    locationCity: null,
    workType: null,
    timezone: null,
    skills: [],
    excitement: null,
    score: null,
    matchReasons: [],
    reviewFlags: [],
    dateFound: '2026-07-29T00:00:00.000Z',
    archived: false,
    tracking: null,
  },
];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/meta')) {
        return {
          ok: true,
          json: async () => ({
            statusOptions: [
              'Lead',
              'Applied',
              'Recruiter Screen',
              'Tech Round',
              'Onsite',
              'Offer',
              'Rejected',
              'Passed',
            ],
            excitementOptions: ['Vera level'],
          }),
        } as unknown as Response;
      }
      if (url.includes('/jobs')) {
        return {
          ok: true,
          json: async () => ({ rows: ROWS, total: ROWS.length, limit: 200, offset: 0 }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TrackerPage profile="rajni" />
    </QueryClientProvider>,
  );
}

describe('TrackerPage', () => {
  it('groups rows into status columns, excluding the undecided row', async () => {
    stubFetch();
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument();
    });
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();

    // Column headers render in vocab order, terminals excluded (the
    // select-value echoes a bare status too, so scope to the header divs).
    const headers = Array.from(
      container.querySelectorAll('div.border-b.font-medium'),
    ).map((el) => el.textContent?.trim());
    expect(headers).toEqual([
      'Lead (1)',
      'Applied (1)',
      'Recruiter Screen (0)',
      'Tech Round (0)',
      'Onsite (0)',
      'Offer (0)',
    ]);

    // Terminal statuses pool into the collapsed Closed column instead.
    expect(screen.getByText('Closed (0)')).toBeInTheDocument();
  });

  it('shows an overdue row in the due strip', async () => {
    stubFetch();
    renderPage();

    const badges = await screen.findAllByText(/⚡ Acme/);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('follow up');
  });
});
