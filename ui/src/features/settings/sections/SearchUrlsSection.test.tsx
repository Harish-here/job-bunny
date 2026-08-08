import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../config.api';
import { SearchUrlsSection } from './SearchUrlsSection';
import { serializeSearchUrlRows } from './searchUrls.model';

vi.mock('../config.api', () => ({
  getConfigDoc: vi.fn(),
  putConfigDoc: vi.fn(),
}));

const EXISTING_ROWS = [
  {
    slug: 'linkedin__jobs-search',
    label: 'Staff Frontend Engineer',
    url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
  },
];

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SearchUrlsSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SearchUrlsSection', () => {
  it('renders an existing row from the loaded doc', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: serializeSearchUrlRows(EXISTING_ROWS),
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Staff Frontend Engineer')).toBeInTheDocument();
    });
  });

  it('a non-linkedin URL is rejected inline and never reaches putConfigDoc', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '' });
    renderSection();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add another search URL' }),
    );
    await userEvent.type(screen.getByLabelText('Search URL'), 'https://example.com/jobs');
    await userEvent.type(screen.getByLabelText('Label'), 'Not LinkedIn');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('That URL is not a linkedin.com address.'),
    ).toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });

  it('a valid new row round-trips into the mutation payload', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '' });
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '' });
    renderSection();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add another search URL' }),
    );
    await userEvent.type(
      screen.getByLabelText('Search URL'),
      'https://www.linkedin.com/jobs/search/?keywords=frontend',
    );
    await userEvent.type(screen.getByLabelText('Label'), 'Frontend Roles');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalled());
    const [, , text] = vi.mocked(configApi.putConfigDoc).mock.calls[0]!;
    expect(text).toEqual(
      serializeSearchUrlRows([
        {
          slug: 'linkedin__jobs-search',
          label: 'Frontend Roles',
          url: 'https://www.linkedin.com/jobs/search/?keywords=frontend',
        },
      ]),
    );
  });

  it('a server rejection renders the message via data-testid settings-error', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '' });
    vi.mocked(configApi.putConfigDoc).mockRejectedValue(
      new Error('search_urls.md must not be empty'),
    );
    renderSection();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add another search URL' }),
    );
    await userEvent.type(
      screen.getByLabelText('Search URL'),
      'https://www.linkedin.com/jobs/search/?keywords=frontend',
    );
    await userEvent.type(screen.getByLabelText('Label'), 'Frontend Roles');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('settings-error')).toHaveTextContent(
      'search_urls.md must not be empty',
    );
  });
});
