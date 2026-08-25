import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../../lib/router';
import * as softErrorsApi from '../../runs/softErrors.api';
import * as configApi from '../config.api';
import { LandingCapsTable } from './LandingCapsTable';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn() }));
vi.mock('../../runs/softErrors.api', () => ({ getSoftErrors: vi.fn() }));
vi.mock('../../../lib/router', () => ({ navigate: vi.fn() }));

const PROFILE_JSON = {
  settings: {
    source: { maxNewPerLane: 40, maxProbesPerRun: 25 },
    linkedin: { maxCardsPerUrl: 40, maxAgeDays: 30 },
  },
};

function stubDoc() {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({
    text: JSON.stringify(PROFILE_JSON),
  });
}

function stubSoftErrors(
  capsHit: { maxNewPerLane: boolean; maxCardsPerUrl: boolean } = {
    maxNewPerLane: false,
    maxCardsPerUrl: false,
  },
) {
  vi.mocked(softErrorsApi.getSoftErrors).mockResolvedValue({
    total: 0,
    groups: [],
    breakerOpen: false,
    capsHit,
  });
}

function renderTable(profile = 'rajni', runId: number | null = 1) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<LandingCapsTable profile={profile} runId={runId} />, { wrapper });
}

function row(container: HTMLElement, dataQa: string): HTMLElement {
  const el = container.querySelector(`[data-qa="${dataQa}"]`);
  if (!el) throw new Error(`row not found: ${dataQa}`);
  return el as HTMLElement;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LandingCapsTable', () => {
  it('renders the binding badge on exactly the max-new-per-lane row, and a plain em-dash (no badge) on max-probes-per-run', async () => {
    stubDoc();
    stubSoftErrors({ maxNewPerLane: true, maxCardsPerUrl: false });
    const { container } = renderTable();
    await waitFor(() =>
      expect(row(container, 'landing-cap-row-max-new-per-lane').textContent).toContain(
        'Hit',
      ),
    );
    const probesRow = row(container, 'landing-cap-row-max-probes-per-run');
    expect(probesRow.textContent).toContain('—');
    expect(probesRow.textContent).not.toContain('Hit');
  });

  it('maxAgeDays always renders a plain em-dash, regardless of capsHit content', async () => {
    stubDoc();
    stubSoftErrors({ maxNewPerLane: true, maxCardsPerUrl: true });
    const { container } = renderTable();
    await waitFor(() =>
      expect(row(container, 'landing-cap-row-max-new-per-lane').textContent).toContain(
        'Hit',
      ),
    );

    const ageRow = row(container, 'landing-cap-row-max-age-days');
    expect(ageRow.textContent).toContain('—');
    expect(ageRow.textContent).not.toContain('Hit');
    expect(ageRow.textContent).toContain('30');
  });

  it("every row's [Change →] navigates to the fetching settings section", async () => {
    stubDoc();
    stubSoftErrors();
    renderTable();
    await screen.findByText('maxNewPerLane');

    const buttons = screen.getAllByRole('button', { name: 'Change →' });
    expect(buttons).toHaveLength(4);
    await userEvent.click(buttons[0] as HTMLElement);

    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'fetching' as never,
    });
  });

  it('renders the four cap values from profile.json settings, falling back to defaults for a malformed doc', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: 'not json' });
    stubSoftErrors();
    const { container } = renderTable();
    await screen.findByText('maxNewPerLane');

    // Malformed doc degrades to the shipped defaults, never a blank/wrong number.
    expect(row(container, 'landing-cap-row-max-new-per-lane').textContent).toContain(
      '40',
    );
    expect(row(container, 'landing-cap-row-max-probes-per-run').textContent).toContain(
      '25',
    );
    expect(row(container, 'landing-cap-row-max-age-days').textContent).toContain('30');
  });
});
