import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../config.api';
import { HousekeepingSection } from './HousekeepingSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));

// Deliberately distinct from HousekeepingSection's own shipped defaults
// (30/2/7/30) — a value equal to the default would let a `waitFor` on that
// value pass trivially on the very first synchronous (pre-load) render,
// never actually waiting for the async doc load.
const BASE_PROFILE_JSON = {
  connector: 'sqlite',
  routines: ['cleanup'],
  settings: {
    cleanup: {
      runsOlderThanDays: 45,
      checkpointsOlderThanDays: 5,
      passedOlderThanDays: 12,
      untouchedOlderThanDays: 60,
    },
  },
};

function stubDoc(doc: Record<string, unknown> = BASE_PROFILE_JSON) {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({
    text: `${JSON.stringify(doc, null, 2)}\n`,
  });
}

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<HousekeepingSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('HousekeepingSection', () => {
  it("pre-fills its TTL fields from the loaded doc's current values", async () => {
    stubDoc();
    renderSection();

    await waitFor(() =>
      expect(screen.getByLabelText('Runs older than (days)')).toHaveValue(45),
    );
    expect(screen.getByLabelText('Checkpoints older than (days)')).toHaveValue(5);
    expect(screen.getByLabelText('Passed jobs older than (days)')).toHaveValue(12);
    expect(screen.getByLabelText('Untouched jobs older than (days)')).toHaveValue(60);
    expect(screen.getByText('cleanup')).toBeInTheDocument();
  });

  it('editing runsOlderThanDays and saving round-trips it at settings.cleanup.runsOlderThanDays', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    const field = await screen.findByLabelText('Runs older than (days)');
    await waitFor(() => expect(field).toHaveValue(45));
    await user.clear(field);
    await user.type(field, '90');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(call[2]);
    expect(written.settings.cleanup.runsOlderThanDays).toBe(90);
    // Untouched cleanup fields and unrelated keys survive the round-trip.
    expect(written.settings.cleanup.checkpointsOlderThanDays).toBe(5);
    expect(written.routines).toEqual(['cleanup']);
  });

  it('extracted routines: adding and removing a routine via the shared ChipInput', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('cleanup');
    await user.click(screen.getByRole('button', { name: 'Remove cleanup' }));
    await user.type(screen.getByRole('textbox', { name: 'Routines' }), 'digest');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(call[2]);
    expect(written.routines).toEqual(['digest']);
  });
});
