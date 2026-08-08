import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardProfile } from '../../lib/api/types';
import { Shell } from './Shell';
import { resetSidebarCollapsedForTests } from './useSidebarCollapsed';

beforeAll(() => {
  // radix Select (inside TriagePage's FilterPopover) needs these in jsdom.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

const PROFILES: BoardProfile[] = [
  { name: 'rajni', connector: 'sqlite', hasDb: true },
  { name: 'harish', connector: 'sqlite', hasDb: false },
];

function stubFetch(opts: {
  failProfiles?: 'always' | 'once';
  profiles?: BoardProfile[];
  version?: string;
}) {
  let profileCalls = 0;
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // `endsWith`, not `includes` — every profile-scoped URL below
    // (`/jobs`, `/meta`, `/config/...`) also contains this substring.
    if (url.endsWith('/api/profiles')) {
      profileCalls += 1;
      const shouldFail =
        opts.failProfiles === 'always' ||
        (opts.failProfiles === 'once' && profileCalls === 1);
      if (shouldFail) throw new Error('network down');
      return {
        ok: true,
        json: async () => ({ profiles: opts.profiles ?? PROFILES }),
      } as unknown as Response;
    }
    if (url.includes('/api/app')) {
      return {
        ok: true,
        json: async () => ({ version: opts.version ?? '2.1.0' }),
      } as unknown as Response;
    }
    if (url.includes('/run-intents')) {
      return { ok: true, json: async () => ({ rows: [] }) } as unknown as Response;
    }
    // TriagePage (the default route's real page, wired in T10) fetches its
    // own jobs/meta — Shell's own tests only care that it renders *for the
    // resolved profile*, proven below via these call URLs, not via a
    // placeholder string.
    if (url.includes('/meta')) {
      return {
        ok: true,
        json: async () => ({ statusOptions: [], excitementOptions: [] }),
      } as unknown as Response;
    }
    if (url.includes('/jobs')) {
      return {
        ok: true,
        json: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
      } as unknown as Response;
    }
    if (url.includes('/config/')) {
      return { ok: true, json: async () => ({ text: '' }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
  vi.stubGlobal('fetch', impl as unknown as typeof fetch);
  return impl;
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.location.hash = '';
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSidebarCollapsedForTests();
});

describe('Shell', () => {
  it('renders branded sidebar, version, all nav items, and defaults the profile', async () => {
    const impl = stubFetch({});
    renderShell();

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'JOB BUNNY' })).toBeInTheDocument();
    });

    expect(screen.getByAltText('Job Bunny')).toBeInTheDocument();
    expect(screen.getByText('v2.1.0')).toBeInTheDocument();
    for (const label of [
      'Triage',
      'Tracker',
      'Runs',
      'Analytics',
      'Onboarding',
      'Settings',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByTestId('run-now')).toHaveTextContent('Run now');

    // Default hash route is triage; TriagePage rendering proves the switch
    // wired it in, and the jobs fetch targeting rajni proves pickProfile
    // picked the DB-backed one over the DB-less one (harish) with nothing
    // stored yet.
    expect(await screen.findByPlaceholderText('Search company…')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        impl.mock.calls.some(([input]) =>
          String(input).includes('/api/profiles/rajni/jobs'),
        ),
      ).toBe(true);
    });
  });

  it('renders a retry state when the server is unreachable, and retry refetches', async () => {
    stubFetch({ failProfiles: 'once' });
    renderShell();

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText(/can't reach the job bunny server/i)).toBeInTheDocument();

    await userEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'JOB BUNNY' })).toBeInTheDocument();
    });
    expect(await screen.findByPlaceholderText('Search company…')).toBeInTheDocument();
  });

  it('renders SettingsPage on the settings route', async () => {
    stubFetch({});
    window.location.hash = '#/settings';
    renderShell();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  // First-boot redirect (phase 3 task 4): once the profiles query resolves
  // successfully with zero profiles, Shell navigates to `#/onboarding` and
  // renders `<WizardPage />` full-screen. It must never do so while the
  // query is pending or once it has errored — `noProfiles` requires
  // `profilesQuery.isSuccess`, so in both of those states no redirect is
  // even reachable, which is what makes a plain post-render assertion
  // (no `waitFor` needed for the negative cases) a reliable check here.
  it('redirects to onboarding when the profiles query resolves with zero profiles', async () => {
    stubFetch({ profiles: [] });
    renderShell();

    await waitFor(() => {
      expect(window.location.hash).toBe('#/onboarding');
    });
    expect(screen.getByTestId('wizard')).toBeInTheDocument();
  });

  it('does not redirect while the profiles query is still loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    renderShell();

    expect(window.location.hash).toBe('');
  });

  it('does not redirect when the profiles query errors', async () => {
    stubFetch({ failProfiles: 'always' });
    renderShell();

    await screen.findByRole('button', { name: 'Retry' });
    expect(window.location.hash).toBe('');
  });

  it('collapses to the rail and remembers it', async () => {
    stubFetch({});
    renderShell();

    const toggle = await screen.findByRole('button', { name: 'Toggle sidebar' });
    await userEvent.click(toggle);

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    expect(localStorage.getItem('jobbunny.sidebar')).toBe('collapsed');

    for (const label of [
      'Triage',
      'Tracker',
      'Runs',
      'Analytics',
      'Onboarding',
      'Settings',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });
});
