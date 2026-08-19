import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../runs/runs.api';
import * as softErrorsApi from '../../runs/softErrors.api';
import * as configApi from '../config.api';
import { FetchingSection } from './FetchingSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));
vi.mock('../../runs/softErrors.api', () => ({ getSoftErrors: vi.fn() }));

const NORMAL_PROFILE_JSON = {
  connector: 'sqlite',
  settings: {
    source: { maxNewPerLane: 40, maxProbesPerRun: 25 },
    linkedin: {
      maxCardsPerUrl: 40,
      maxAgeDays: 30,
      jitterMinMs: 5_000,
      jitterMaxMs: 12_000,
      interUrlDelayMinMs: 20_000,
      interUrlDelayMaxMs: 45_000,
    },
  },
};

function stubDoc(profileDoc: Record<string, unknown> = NORMAL_PROFILE_JSON) {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({
    text: JSON.stringify(profileDoc),
  });
}

function stubRuns(rows: Array<{ id: number }> = []) {
  vi.mocked(runsApi.listRuns).mockResolvedValue({
    rows: rows.map((r) => ({
      id: r.id,
      status: 'success',
      startedAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T00:05:00.000Z',
    })) as never,
    total: rows.length,
    limit: 100,
    offset: 0,
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

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<FetchingSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('FetchingSection', () => {
  it('renders the four cap fields with their bounds and effect copy, maxAgeDays phrased as freshness never yield', async () => {
    stubDoc();
    stubRuns();
    stubSoftErrors();
    const { container } = renderSection();

    await screen.findByText('maxNewPerLane');
    expect(
      container.querySelector('[data-qa="fetch-cap-max-new-per-lane"]')?.textContent,
    ).toContain('1–500');
    expect(
      container.querySelector('[data-qa="fetch-cap-max-age-days"]')?.textContent,
    ).toContain('Postings older than 30 days are skipped.');
    expect(
      container.querySelector('[data-qa="fetch-cap-max-age-days"]')?.textContent,
    ).not.toContain('caps jobs');
  });

  it('renders the binding-marker clause only when the last run actually hit that cap', async () => {
    stubDoc();
    stubRuns([{ id: 7 }]);
    stubSoftErrors({ maxNewPerLane: true, maxCardsPerUrl: false });
    const { container } = renderSection();

    await waitFor(() =>
      expect(
        container.querySelector('[data-qa="fetch-cap-max-new-per-lane"]')?.textContent,
      ).toContain('Your last run hit this cap.'),
    );
    expect(
      container.querySelector('[data-qa="fetch-cap-max-cards-per-url"]')?.textContent,
    ).not.toContain('Your last run hit this cap.');
    expect(
      container.querySelector('[data-qa="fetch-cap-max-probes-per-run"]')?.textContent,
    ).not.toContain('Your last run hit this cap.');
  });

  it('the pacing radiogroup starts on Normal (current) for the fixture, and editing a raw field switches to the unstyled Custom state', async () => {
    stubDoc();
    stubRuns();
    stubSoftErrors();
    const user = userEvent.setup();
    const { container } = renderSection();

    const normalRadio = await screen.findByRole('radio', { name: /Normal/ });
    expect(normalRadio).toHaveAttribute('data-state', 'checked');
    expect(normalRadio.textContent).toContain('current');

    await user.click(screen.getByRole('button', { name: /Advanced/ }));
    const jitterMinInput = within(
      container.querySelector('[data-qa="pacing-raw-jitter-min"]') as HTMLElement,
    ).getByRole('spinbutton');
    await user.clear(jitterMinInput);
    await user.type(jitterMinInput, '9999');

    await waitFor(() => {
      for (const name of [/Safe/, /Normal/, /Fast/]) {
        expect(screen.getByRole('radio', { name })).toHaveAttribute(
          'data-state',
          'unchecked',
        );
      }
    });
  });

  it('Save proceeds with Fast selected and the ack left unchecked (the ack never blocks save)', async () => {
    stubDoc();
    stubRuns();
    stubSoftErrors();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('radio', { name: /Fast/ }));
    expect(screen.getByRole('checkbox', { name: /soft-block/ })).not.toBeChecked();

    await user.click(await screen.findByTestId('save-button'));

    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'profile.json',
        expect.any(String),
      ),
    );
    const [, , text] = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(text);
    expect(written.settings.linkedin.jitterMinMs).toBe(2_000);
  });

  it('checking the Fast ack, switching to Safe then back to Fast leaves the ack UNCHECKED (clear-on-switch, not merely absence)', async () => {
    stubDoc();
    stubRuns();
    stubSoftErrors();
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('radio', { name: /Fast/ }));
    const ack = screen.getByRole('checkbox', { name: /soft-block/ });
    await user.click(ack);
    expect(ack).toBeChecked();

    await user.click(screen.getByRole('radio', { name: /Safe/ }));
    await user.click(screen.getByRole('radio', { name: /Fast/ }));

    expect(screen.getByRole('checkbox', { name: /soft-block/ })).not.toBeChecked();
  });

  it('the save button is never disabled, even with Fast selected and the ack unchecked', async () => {
    stubDoc();
    stubRuns();
    stubSoftErrors();
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('radio', { name: /Fast/ }));
    const saveButton = await screen.findByTestId('save-button');
    expect(saveButton).not.toBeDisabled();
  });
});
