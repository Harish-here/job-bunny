import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HubPage } from './HubPage';
import type { DoctorStatus } from './hub.api';

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

function stubFetch(opts: {
  findings?: { check: string; status: DoctorStatus; detail: string }[];
  daemonState?: 'running' | 'stopped' | 'stale';
  scheduleEnabled?: boolean;
  scheduleTimes?: string[];
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/doctor')) {
        return {
          ok: true,
          json: async () => ({ status: 'ok', findings: opts.findings ?? [] }),
        } as unknown as Response;
      }
      if (url.includes('/api/daemon')) {
        const state = opts.daemonState ?? 'running';
        return {
          ok: true,
          json: async () => ({
            state,
            pid: null,
            startedAt: null,
            lastTickAt: null,
            inFlight: null,
            profiles: [],
          }),
        } as unknown as Response;
      }
      if (url.includes('/config/profile.json')) {
        const schedule = {
          enabled: opts.scheduleEnabled ?? false,
          times: opts.scheduleTimes ?? [],
        };
        return {
          ok: true,
          json: async () => ({ text: JSON.stringify({ schedule }) }),
        } as unknown as Response;
      }
      if (url.includes('/api/personas')) {
        return {
          ok: true,
          json: async () => ({ version: 1, personas: [] }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

function renderHub() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<HubPage profile="rajni" />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HubPage', () => {
  it('renders all six cards in the frozen order', async () => {
    stubFetch({});
    renderHub();
    const cards = await screen.findAllByTestId('hub-card');
    expect(cards.map((c) => c.getAttribute('data-card-id'))).toEqual([
      'profile',
      'persona-filters',
      'search-urls',
      'integrations',
      'schedule-daemon',
      'pipeline-health',
    ]);
  });

  it('shows the schedule banner when the daemon is down and a schedule is enabled', async () => {
    stubFetch({
      daemonState: 'stopped',
      scheduleEnabled: true,
      scheduleTimes: ['09:00'],
    });
    renderHub();

    const banner = await screen.findByTestId('hub-banner');
    expect(banner).toHaveTextContent("Scheduled for 09:00 but the daemon isn't running");
    expect(within(banner).getByText('jobbunny serve start')).toBeInTheDocument();
  });

  it.each([
    ['running', true],
    ['stopped', false],
  ] as const)(
    'does not show the banner for daemonState=%s scheduleEnabled=%s',
    async (daemonState, scheduleEnabled) => {
      stubFetch({ daemonState, scheduleEnabled, scheduleTimes: ['09:00'] });
      renderHub();

      await screen.findAllByTestId('hub-card');
      expect(screen.queryByTestId('hub-banner')).not.toBeInTheDocument();
    },
  );

  it('renders a finding under the card its check maps to, and sets that card status', async () => {
    stubFetch({
      findings: [
        { check: 'filter-parses', status: 'warn', detail: 'filter.json has an error' },
      ],
    });
    renderHub();

    const cards = await screen.findAllByTestId('hub-card');
    const card = cards.find(
      (el) => el.getAttribute('data-card-id') === 'persona-filters',
    );
    if (!card) throw new Error('persona-filters card not found');
    expect(card).toHaveAttribute('data-status', 'warn');
    expect(within(card).getByTestId('hub-finding')).toHaveTextContent(
      'filter.json has an error',
    );

    const profileCard = cards.find((el) => el.getAttribute('data-card-id') === 'profile');
    if (!profileCard) throw new Error('profile card not found');
    expect(profileCard).toHaveAttribute('data-status', 'unknown');
  });

  it('navigates to the onboarding wizard from "Set up a new profile"', async () => {
    stubFetch({});
    renderHub();
    await screen.findAllByTestId('hub-card');

    window.location.hash = '';
    await userEvent.click(screen.getByRole('button', { name: 'Set up a new profile' }));
    expect(window.location.hash).toBe('#/onboarding');
  });

  it('opens the persona-filters dialog from "Set up" when its status is not ok', async () => {
    stubFetch({
      findings: [
        { check: 'filter-parses', status: 'warn', detail: 'filter.json has an error' },
      ],
    });
    renderHub();

    const cards = await screen.findAllByTestId('hub-card');
    const card = cards.find(
      (el) => el.getAttribute('data-card-id') === 'persona-filters',
    );
    if (!card) throw new Error('persona-filters card not found');

    await userEvent.click(within(card).getByRole('button', { name: 'Set up' }));
    const panel = await screen.findByTestId('hub-panel');
    expect(panel).toHaveAttribute('data-card-id', 'persona-filters');
  });

  it('shows "Edit in Settings" and no dialog for an ok persona-filters card', async () => {
    stubFetch({
      findings: [{ check: 'filter-parses', status: 'ok', detail: 'filter.json parses.' }],
    });
    renderHub();

    const cards = await screen.findAllByTestId('hub-card');
    const card = cards.find(
      (el) => el.getAttribute('data-card-id') === 'persona-filters',
    );
    if (!card) throw new Error('persona-filters card not found');

    expect(
      within(card).getByRole('button', { name: 'Edit in Settings' }),
    ).toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: 'Set up' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('hub-panel')).not.toBeInTheDocument();
  });
});
