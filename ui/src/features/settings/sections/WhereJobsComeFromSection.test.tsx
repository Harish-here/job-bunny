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
    page: 'linkedin__jobs-search',
    label: 'Staff Frontend Engineer',
    url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
    touched: true,
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
      expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked(),
    );
    expect(screen.getByRole('checkbox', { name: 'Greenhouse' })).not.toBeChecked();
    expect(screen.getByDisplayValue('Staff Frontend Engineer')).toBeInTheDocument();
  });

  it('toggling a lane checkbox is reflected in the dirty save bar (editor state changed)', async () => {
    stubDocs();
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked(),
    );
    expect(screen.queryByTestId('save-bar')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Greenhouse' }));
    expect(await screen.findByTestId('save-bar')).toBeInTheDocument();
  });

  it('a lane toggle round-trips into the saved payload, preserving unknown lane names', async () => {
    stubDocs();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked(),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Greenhouse' }));
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
    // An empty search_urls.md auto-adds one row (ux-notes C12) — no manual
    // "Add another search URL" click needed; this exercises that
    // auto-added row directly.
    stubDocs({}, '');
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    await user.type(
      await screen.findByLabelText('Search URL'),
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
    // Moving focus from the URL field to the Label field blurs the URL
    // input, running the classify-and-rewrite path — `touched` flips to
    // `true` and `page` resolves from `''` to the classified page.
    expect(text).toEqual(
      serializeSearchUrlRows([
        {
          page: 'linkedin__jobs-search',
          label: 'Frontend Roles',
          url: 'https://www.linkedin.com/jobs/search/?keywords=frontend',
          touched: true,
        },
      ]),
    );
  });

  it('a non-linkedin URL surfaces the validation summary and blocks the save', async () => {
    stubDocs({}, '');
    const user = userEvent.setup();
    renderSection();

    await user.type(
      await screen.findByLabelText('Search URL'),
      'https://example.com/jobs',
    );
    await user.type(screen.getByLabelText('Label'), 'Not LinkedIn');

    expect(await screen.findByTestId('validation-summary')).toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });

  it('B2: Re-file is disabled with a helper hint while the section is dirty, and never PUTs', async () => {
    // A misfiled row (stored page disagrees with what the URL classifies
    // as) so the Re-file button renders at all.
    const MISFILED_ROWS = [
      {
        page: 'linkedin__jobs-search-results',
        label: 'Staff Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
        touched: true,
      },
    ];
    stubDocs({}, serializeSearchUrlRows(MISFILED_ROWS));
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked(),
    );
    // Dirty the lanes card only — never clicking the section Save button.
    await user.click(screen.getByRole('checkbox', { name: 'Greenhouse' }));
    expect(await screen.findByTestId('save-bar')).toBeInTheDocument();

    const refileButton = await screen.findByRole('button', { name: 'Re-file 1 link' });
    expect(refileButton).toBeDisabled();
    expect(
      screen.getByText('Save or discard your changes first, then re-file.'),
    ).toBeInTheDocument();

    await user.click(refileButton);
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });

  it('B2: once clean, Re-file PUTs search_urls.md alone (re-seeding rows, never touching profile.json)', async () => {
    const MISFILED_ROWS = [
      {
        page: 'linkedin__jobs-search-results',
        label: 'Staff Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
        touched: true,
      },
    ];
    stubDocs({}, serializeSearchUrlRows(MISFILED_ROWS));
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({
      text: serializeSearchUrlRows([
        {
          page: 'linkedin__jobs-search',
          label: 'Staff Frontend Engineer',
          url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
          touched: true,
        },
      ]),
    });
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked(),
    );
    const refileButton = await screen.findByRole('button', { name: 'Re-file 1 link' });
    expect(refileButton).not.toBeDisabled();

    await user.click(refileButton);

    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'search_urls.md',
        expect.any(String),
      ),
    );
    expect(
      vi
        .mocked(configApi.putConfigDoc)
        .mock.calls.some(([, doc]) => doc === 'profile.json'),
    ).toBe(false);
    expect(await screen.findByTestId('save-success-line')).toHaveTextContent(
      'Re-filed 1 link.',
    );
  });

  it('a label-only row with an empty URL never blocks Save', async () => {
    stubDocs();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked(),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Add another search URL' }),
    );
    const labelInputs = screen.getAllByLabelText('Label');
    const newLabelInput = labelInputs[labelInputs.length - 1];
    if (!newLabelInput) throw new Error('expected a newly-added Label input');
    await user.type(newLabelInput, 'Foo');

    // No entry in saveState.errors for the label-only row, so no summary —
    // `validateRow`'s first line short-circuits on an empty URL before the
    // label-required check, regardless of whether the label is filled in.
    expect(screen.queryByTestId('validation-summary')).not.toBeInTheDocument();

    await user.click(await screen.findByTestId('save-button'));

    // Save proceeds, unblocked — searchUrlsMutation.mutateAsync (routed
    // through putConfigDoc) is still called.
    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'search_urls.md',
        expect.any(String),
      ),
    );
  });

  it('B3: a non-URL-matching save failure (5xx/network) shows a general save-error alert, never a row error', async () => {
    stubDocs({}, '');
    vi.mocked(configApi.putConfigDoc).mockImplementation((_p, doc) => {
      if (doc === 'search_urls.md')
        return Promise.reject(new Error('database is locked'));
      return Promise.resolve({ text: 'ok' });
    });
    const user = userEvent.setup();
    renderSection();

    await user.type(
      await screen.findByLabelText('Search URL'),
      'https://www.linkedin.com/jobs/search/?keywords=frontend',
    );
    await user.type(screen.getByLabelText('Label'), 'Frontend Roles');
    await user.click(await screen.findByTestId('save-button'));

    expect(await screen.findByTestId('search-urls-save-error')).toHaveTextContent(
      "Couldn't save search links. Check your connection and try again.",
    );
    expect(screen.queryByTestId('validation-summary')).not.toBeInTheDocument();
  });

  it('B3/B4: a failed Re-file (network error) surfaces the same general save-error alert, no unhandled rejection', async () => {
    const MISFILED_ROWS = [
      {
        page: 'linkedin__jobs-search-results',
        label: 'Staff Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
        touched: true,
      },
    ];
    stubDocs({}, serializeSearchUrlRows(MISFILED_ROWS));
    vi.mocked(configApi.putConfigDoc).mockRejectedValue(new Error('Failed to fetch'));
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked(),
    );
    await user.click(await screen.findByRole('button', { name: 'Re-file 1 link' }));

    expect(await screen.findByTestId('search-urls-save-error')).toHaveTextContent(
      "Couldn't save search links. Check your connection and try again.",
    );
    expect(screen.queryByTestId('validation-summary')).not.toBeInTheDocument();
  });
});
