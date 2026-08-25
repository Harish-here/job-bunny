import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../runs/runs.api';
import * as configApi from '../config.api';
import { serializeSearchUrlRows } from './searchUrls.model';
import { WhereJobsComeFromSection } from './WhereJobsComeFromSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));

const BASE_PROFILE_JSON = {
  connector: 'sqlite',
  lanes: ['linkedin', 'a-future-lane'],
  notifiers: [],
  routines: [],
};

const EXISTING_ROWS = [
  {
    slug: 'linkedin__jobs-search',
    label: 'Staff Frontend Engineer',
    url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
  },
];

function stubDocs(
  profileOverrides: Record<string, unknown> = {},
  searchUrlsText = serializeSearchUrlRows(EXISTING_ROWS),
) {
  const profile = { ...BASE_PROFILE_JSON, ...profileOverrides };
  vi.mocked(configApi.getConfigDoc).mockImplementation((_p, doc) => {
    if (doc === 'search_urls.md') return Promise.resolve({ text: searchUrlsText });
    return Promise.resolve({ text: `${JSON.stringify(profile, null, 2)}\n` });
  });
  vi.mocked(runsApi.listRuns).mockResolvedValue({
    rows: [],
    total: 0,
    limit: 1,
    offset: 0,
  });
}

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<WhereJobsComeFromSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WhereJobsComeFromSection', () => {
  it('renders both cards, pre-filled from the loaded docs', async () => {
    stubDocs();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'linkedin' })).toBeChecked(),
    );
    expect(screen.getByRole('checkbox', { name: 'greenhouse' })).not.toBeChecked();
    expect(screen.getByDisplayValue('Staff Frontend Engineer')).toBeInTheDocument();
  });

  it('toggling a lane checkbox is reflected in the dirty save bar (editor state changed)', async () => {
    stubDocs();
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'linkedin' })).toBeChecked(),
    );
    expect(screen.queryByTestId('save-bar')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'greenhouse' }));
    expect(await screen.findByTestId('save-bar')).toBeInTheDocument();
  });

  it('a lane toggle round-trips into the saved payload, preserving unknown lane names', async () => {
    stubDocs();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'linkedin' })).toBeChecked(),
    );
    await user.click(screen.getByRole('checkbox', { name: 'greenhouse' }));
    await user.click(await screen.findByTestId('save-button'));

    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'profile.json',
        expect.any(String),
      ),
    );
    const profileCall = vi
      .mocked(configApi.putConfigDoc)
      .mock.calls.find(([, doc]) => doc === 'profile.json');
    const [, , text] = profileCall as [string, string, string];
    const written = JSON.parse(text);
    expect([...written.lanes].sort()).toEqual([
      'a-future-lane',
      'greenhouse',
      'linkedin',
    ]);
  });

  it('editing a search-URL row is reflected live and round-trips on save', async () => {
    stubDocs({}, '');
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole('button', { name: 'Add another search URL' }),
    );
    await user.type(
      screen.getByLabelText('Search URL'),
      'https://www.linkedin.com/jobs/search/?keywords=frontend',
    );
    await user.type(screen.getByLabelText('Label'), 'Frontend Roles');
    expect(screen.getByLabelText('Label')).toHaveValue('Frontend Roles');

    await user.click(await screen.findByTestId('save-button'));

    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'search_urls.md',
        expect.any(String),
      ),
    );
    const searchUrlsCall = vi
      .mocked(configApi.putConfigDoc)
      .mock.calls.find(([, doc]) => doc === 'search_urls.md');
    const [, , text] = searchUrlsCall as [string, string, string];
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

  it('a non-linkedin URL surfaces the validation summary and blocks the save', async () => {
    stubDocs({}, '');
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole('button', { name: 'Add another search URL' }),
    );
    await user.type(screen.getByLabelText('Search URL'), 'https://example.com/jobs');
    await user.type(screen.getByLabelText('Label'), 'Not LinkedIn');

    expect(await screen.findByTestId('validation-summary')).toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });
});
