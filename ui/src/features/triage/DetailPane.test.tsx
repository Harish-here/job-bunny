import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardJobDetail } from '../../lib/api/types';
import { DetailPane } from './DetailPane';

beforeAll(() => {
  // radix Select (inside TrackingPanel) needs these in jsdom.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeDetail(overrides: Partial<BoardJobDetail> = {}): BoardJobDetail {
  return {
    id: 'rajni-e2e-1',
    lane: 'greenhouse',
    title: 'Senior Platform Engineer',
    company: 'Acme Corp',
    url: 'https://example.com/jobs/rajni-e2e-1',
    seniority: 'Senior',
    locationCity: 'Bengaluru',
    workType: 'hybrid',
    timezone: 'IST',
    skills: ['Kubernetes', 'Go'],
    excitement: null,
    score: 74,
    matchReasons: ['8 of 10 core skills', 'Remote-first'],
    reviewFlags: [],
    dateFound: '2026-08-24T21:00:00.000Z',
    archived: false,
    tracking: null,
    jd: {
      identity: {
        id: 'rajni-e2e-1',
        lane: 'greenhouse',
        url: 'https://example.com/jobs/rajni-e2e-1',
        company: 'Acme Corp',
        title: 'Senior Platform Engineer',
        scrapedAt: '2026-08-24T21:00:00.000Z',
      },
      content: { rawText: 'We are hiring a senior platform engineer.' },
    },
    ...overrides,
  };
}

function stubMetaFetch() {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/meta')) {
      return {
        ok: true,
        json: async () => ({ statusOptions: ['Lead', 'Applied'], excitementOptions: [] }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
  vi.stubGlobal('fetch', impl as unknown as typeof fetch);
  return impl;
}

function renderDetailPane(props: Partial<Parameters<typeof DetailPane>[0]> = {}) {
  stubMetaFetch();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDecide = vi.fn();
  const onToggleJdExpanded = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <DetailPane
        profile="rajni"
        detail={makeDetail()}
        onDecide={onDecide}
        jdExpanded={false}
        onToggleJdExpanded={onToggleJdExpanded}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onDecide, onToggleJdExpanded };
}

describe('DetailPane', () => {
  it('renders the 8 zones in DOM order inside one detail-pane Card', () => {
    renderDetailPane();

    const pane = document.querySelector('[data-qa="detail-pane"]');
    expect(pane).not.toBeNull();

    const ids = [
      'verdict-header',
      'signals',
      'eligibility',
      'skills',
      'jd',
      'tracking',
      'decide-bar',
    ];
    const allTagged = Array.from(pane?.querySelectorAll('[data-qa]') ?? []);
    const positions = ids.map((id) => {
      const el = pane?.querySelector(`[data-qa="${id}"]`);
      expect(el, `missing [data-qa="${id}"]`).not.toBeNull();
      return allTagged.indexOf(el as Element);
    });
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] as number);
    }
  });

  it('forwards onDecide to DecideBar', async () => {
    const { onDecide } = renderDetailPane();

    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onDecide).toHaveBeenCalledWith('apply');
  });

  it('forwards jdExpanded/onToggleJdExpanded to JdText, does not own the state', async () => {
    const { onToggleJdExpanded } = renderDetailPane({ jdExpanded: false });

    await userEvent.click(screen.getByRole('button', { name: /show full description/i }));
    expect(onToggleJdExpanded).toHaveBeenCalledTimes(1);
  });

  it('sparse job: no match reasons, no skills, no description', () => {
    renderDetailPane({
      detail: makeDetail({
        matchReasons: [],
        reviewFlags: [],
        skills: [],
        locationCity: null,
        workType: null,
        seniority: null,
        timezone: null,
        jd: {
          identity: {
            id: 'rajni-e2e-11',
            lane: 'greenhouse',
            url: 'https://example.com/jobs/rajni-e2e-11',
            company: 'Nimbus Works',
            title: 'Backend Engineer (Contract)',
            scrapedAt: '2026-08-24T21:00:00.000Z',
          },
        },
      }),
    });

    expect(screen.getByText('No match reasons recorded.')).toBeInTheDocument();
    expect(document.querySelector('[data-qa="review-flags"]')).toBeNull();
    expect(screen.getByText('No skills extracted.')).toBeInTheDocument();
    expect(screen.getByText('No description captured for this job.')).toBeInTheDocument();
    expect(screen.getByText('Open original')).toBeInTheDocument();
  });
});
