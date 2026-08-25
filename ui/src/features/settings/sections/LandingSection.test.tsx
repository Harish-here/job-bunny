import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GetRunResponse, ListRunsResponse } from '../../../lib/api/types';
import * as runsApi from '../../runs/runs.api';
import * as softErrorsApi from '../../runs/softErrors.api';
import * as configApi from '../config.api';
import { LandingSection } from './LandingSection';

vi.mock('../../runs/runs.api', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  listRunEvents: vi.fn(),
}));
vi.mock('../../runs/softErrors.api', () => ({ getSoftErrors: vi.fn() }));
vi.mock('../config.api', () => ({ getConfigDoc: vi.fn() }));
vi.mock('../../../lib/router', () => ({ navigate: vi.fn() }));

const PROFILE_JSON = {
  settings: {
    source: { maxNewPerLane: 40, maxProbesPerRun: 25 },
    linkedin: { maxCardsPerUrl: 40, maxAgeDays: 30 },
  },
};
const FILTER_JSON = {
  title: {
    domain: { match: ['fintech'], reject: [], severity: 'hard' },
  },
  locations: [{ city: 'Bengaluru', country: 'IN', workTypes: ['remote'] }],
  skills: { core: ['typescript'], minMatch: 1, severity: 'hard' },
};

function stubConfigAndSoftErrors() {
  vi.mocked(configApi.getConfigDoc).mockImplementation((_profile, doc) => {
    if (doc === 'filter.json')
      return Promise.resolve({ text: JSON.stringify(FILTER_JSON) });
    return Promise.resolve({ text: JSON.stringify(PROFILE_JSON) });
  });
  vi.mocked(softErrorsApi.getSoftErrors).mockResolvedValue({
    total: 0,
    groups: [],
    breakerOpen: false,
    capsHit: { maxNewPerLane: false, maxCardsPerUrl: false },
  });
}

const RUN_ROW: ListRunsResponse['rows'][number] = {
  id: 7,
  date: '2026-08-19',
  timeDir: '09-00',
  kind: 'run',
  resumedFrom: null,
  status: 'passed',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  heartbeatAt: null,
  progress: null,
  catchupSlots: null,
  softErrors: {
    total: 0,
    groups: [],
    breakerOpen: false,
    capsHit: { maxNewPerLane: false, maxCardsPerUrl: false },
  },
};

const RUN_DETAIL: GetRunResponse = {
  ...RUN_ROW,
  result: {
    stages: [
      {
        name: 'source',
        jobsIn: 200,
        jobsOut: 190,
        dropsByRule: { badUrl: 3 },
        elapsedMs: 0,
        attempts: 1,
      },
      {
        name: 'filter',
        jobsIn: 190,
        jobsOut: 20,
        dropsByRule: { locations: 150, companies: 20 },
        elapsedMs: 0,
        attempts: 1,
      },
      {
        name: 'rank',
        jobsIn: 20,
        jobsOut: 4,
        dropsByRule: {},
        elapsedMs: 0,
        attempts: 1,
      },
    ],
  },
  failure: null,
  syncDryrun: null,
  estimatedDurationMs: null,
};

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<LandingSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LandingSection', () => {
  it('default: renders the hero number, scraped count and biggest-drop rule, plus the caps and rules tables', async () => {
    stubConfigAndSoftErrors();
    const list: ListRunsResponse = { rows: [RUN_ROW], total: 1, limit: 100, offset: 0 };
    vi.mocked(runsApi.listRuns).mockResolvedValue(list);
    vi.mocked(runsApi.getRun).mockResolvedValue(RUN_DETAIL);

    const { container } = renderSection();

    const card = await waitFor(() => {
      const el = container.querySelector('[data-qa="landing-thin-run"]');
      if (!el) throw new Error('landing-thin-run not found');
      return el as HTMLElement;
    });
    await waitFor(() => expect(card.textContent).toContain('4'));
    expect(card.textContent).toContain('200');
    expect(card.textContent).toContain('locations');
    expect(card.querySelector('.text-2xl')?.textContent).toBe('4');

    expect(container.querySelector('[data-qa="landing-caps-table"]')).not.toBeNull();
    await screen.findByText('Roles & companies');
    expect(container.querySelector('[data-qa="landing-rules-summary"]')).not.toBeNull();

    const footer = container.querySelector('[data-qa="landing-scope-footer"]');
    expect(footer).not.toBeNull();
    const link = screen.getByRole('link', { name: /Operate/ });
    expect(link).toHaveAttribute('href', '#/setup');
  });

  it('empty: GET runs returning [] replaces the thin-run card with a muted "No run recorded yet" line, while the caps/rules tables still render', async () => {
    stubConfigAndSoftErrors();
    const list: ListRunsResponse = { rows: [], total: 0, limit: 100, offset: 0 };
    vi.mocked(runsApi.listRuns).mockResolvedValue(list);
    vi.mocked(runsApi.getRun).mockResolvedValue(RUN_DETAIL);

    const { container } = renderSection();

    await screen.findByText('No run recorded yet');
    const card = container.querySelector('[data-qa="landing-thin-run"]') as HTMLElement;
    expect(card.textContent?.trim()).toBe('No run recorded yet');
    // getRun must never fire when there is no run to look up.
    expect(runsApi.getRun).not.toHaveBeenCalled();

    await screen.findByText('maxNewPerLane');
    expect(container.querySelector('[data-qa="landing-rules-summary"]')).not.toBeNull();
  });

  it('loading: one card skeleton renders while the runs query is pending', async () => {
    stubConfigAndSoftErrors();
    vi.mocked(runsApi.listRuns).mockReturnValue(new Promise(() => {}));
    vi.mocked(runsApi.getRun).mockReturnValue(new Promise(() => {}));

    const { container } = renderSection();

    const skeleton = container.querySelector('[data-qa="landing-thin-run-loading"]');
    expect(skeleton).not.toBeNull();
    // Never a red/amber-shaped placeholder — no error/empty text present yet.
    expect(screen.queryByText('No run recorded yet')).toBeNull();
    expect(screen.queryByText("Couldn't load your last run.")).toBeNull();
  });

  it('error: a runs-query failure renders an inline error-plus-retry block scoped to the thin-run card only, and Retry re-fetches', async () => {
    stubConfigAndSoftErrors();
    vi.mocked(runsApi.listRuns).mockRejectedValue(new Error('network down'));

    const { container } = renderSection();

    await screen.findByText("Couldn't load your last run.");
    const card = container.querySelector('[data-qa="landing-thin-run"]') as HTMLElement;
    expect(card.textContent).toContain("Couldn't load your last run.");

    // Scoped to this one card: the caps/rules tables (independent
    // config-doc queries) are unaffected by the runs-query failure.
    await screen.findByText('maxNewPerLane');
    expect(container.querySelector('[data-qa="landing-rules-summary"]')).not.toBeNull();

    expect(runsApi.listRuns).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(runsApi.listRuns).toHaveBeenCalledTimes(2));
  });
});
