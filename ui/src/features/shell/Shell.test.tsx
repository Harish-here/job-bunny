import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardProfile } from '../../lib/api/types';
import { Shell } from './Shell';

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
    if (url.includes('/api/profiles')) {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shell', () => {
  it('renders branded sidebar, version, all nav items, and defaults the profile', async () => {
    stubFetch({});
    renderShell();

    await waitFor(() => {
      expect(screen.getByText('Job Bunny')).toBeInTheDocument();
    });

    expect(screen.getByAltText('Job Bunny')).toBeInTheDocument();
    expect(screen.getByText('v2.1.0')).toBeInTheDocument();
    for (const label of ['Triage', 'Tracker', 'Analytics', 'Onboarding']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }

    // Default hash route is triage; the placeholder page renders the
    // resolved profile, proving pickProfile picked the DB-backed one (rajni)
    // over the DB-less one (harish) with nothing stored yet.
    expect(screen.getByText('Triage — rajni')).toBeInTheDocument();
  });

  it('renders a retry state when the server is unreachable, and retry refetches', async () => {
    stubFetch({ failProfiles: 'once' });
    renderShell();

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText(/can't reach the job bunny server/i)).toBeInTheDocument();

    await userEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText('Job Bunny')).toBeInTheDocument();
    });
    expect(screen.getByText('Triage — rajni')).toBeInTheDocument();
  });
});
