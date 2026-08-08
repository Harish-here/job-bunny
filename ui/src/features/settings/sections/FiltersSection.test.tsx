import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../config.api';
import { FiltersSection } from './FiltersSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));

const BASE_FILTER_JSON = {
  title: { domain: { match: [], reject: [], severity: 'hard' } },
  companies: { avoid: ['Chargebee'] },
  locations: [],
  timezones: { accept: ['APAC'], severity: 'hard' },
  skills: { core: [], minMatch: 1, severity: 'hard' },
};

function stubDoc(doc: Record<string, unknown> = BASE_FILTER_JSON) {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({
    text: `${JSON.stringify(doc, null, 2)}\n`,
  });
}
function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<FiltersSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('FiltersSection', () => {
  it('a chip round-trips into the mutation payload and preserves companies/timezones', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();

    await screen.findByLabelText('Add to Domain match');
    await user.type(screen.getByLabelText('Add to Domain match'), 'frontend');
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0] as HTMLElement);
    expect(screen.getByText('frontend')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add location' }));
    await user.type(screen.getByLabelText('Location city'), 'Chennai');
    await user.click(screen.getByRole('checkbox', { name: 'remote' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(call[2]);
    expect(written.title.domain.match).toEqual(['frontend']);
    expect(written.locations).toEqual([{ city: 'Chennai', workTypes: ['remote'] }]);
    expect(written.companies).toEqual({ avoid: ['Chargebee'] });
    expect(written.timezones).toEqual({ accept: ['APAC'], severity: 'hard' });
  });

  it('a failed load renders a blocking error and never a Save button', async () => {
    vi.mocked(configApi.getConfigDoc).mockRejectedValue(new Error('network error'));
    renderSection();
    expect(await screen.findByTestId('settings-load-error')).toHaveTextContent(
      "Couldn't load filter.json: network error",
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });

  it('an inline validation error blocks the request', async () => {
    stubDoc();
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Add location' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Enter a city.')).toBeInTheDocument();
    expect(screen.getByText('Pick at least one work type.')).toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });
});
