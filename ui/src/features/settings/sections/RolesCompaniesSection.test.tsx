import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../runs/runs.api';
import * as configApi from '../config.api';
import { RolesCompaniesSection } from './RolesCompaniesSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));

const BASE_FILTER = {
  title: { domain: { match: ['engineer'], reject: ['intern'], severity: 'hard' } },
  companies: { avoid: ['Acme Staffing'] },
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
  timezones: { accept: ['APAC'], severity: 'hard' },
  skills: { core: ['React'], minMatch: 1, severity: 'hard' },
};
const BASE_PROFILE = {
  settings: {
    rank: {
      title: { domainKeywords: ['fintech'], maxPoints: 15, neutralPoints: 8 },
      seniority: { targets: ['Senior'], maxPoints: 15 },
      location: { homeCities: ['Chennai'] },
    },
  },
};

function stubDocs(
  filterOverrides: Record<string, unknown> = {},
  profileOverrides: Record<string, unknown> = {},
) {
  const filter = { ...BASE_FILTER, ...filterOverrides };
  const profile = { ...BASE_PROFILE, ...profileOverrides };
  vi.mocked(configApi.getConfigDoc).mockImplementation((_p, doc) => {
    const value = doc === 'filter.json' ? filter : profile;
    return Promise.resolve({ text: `${JSON.stringify(value, null, 2)}\n` });
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
  return render(<RolesCompaniesSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RolesCompaniesSection', () => {
  it('renders all three cards, each with the existing data for the field(s) it owns', async () => {
    stubDocs();
    renderSection();

    // Waits on data-dependent content, not the (data-independent, always
    // rendered) card title — the rules card's own title text is present
    // even before the real docs finish loading, since EMPTY_STATE's title
    // rules are ALSO empty; racing on it would assert against stale state.
    await screen.findByText('engineer');
    expect(
      screen.getByText('Preferences — these change the order, never drop anything'),
    ).toBeInTheDocument();
    expect(screen.getByText('Companies to avoid')).toBeInTheDocument();

    expect(document.querySelector('[data-qa="roles-rules-card"]')).not.toBeNull();
    expect(document.querySelector('[data-qa="roles-prefs-card"]')).not.toBeNull();
    expect(document.querySelector('[data-qa="companies-avoid-card"]')).not.toBeNull();

    const rulesCard = document.querySelector(
      '[data-qa="roles-rules-card"]',
    ) as HTMLElement;
    expect(within(rulesCard).getByText('engineer')).toBeInTheDocument();
    expect(within(rulesCard).getByText('intern')).toBeInTheDocument();

    const prefsCard = document.querySelector(
      '[data-qa="roles-prefs-card"]',
    ) as HTMLElement;
    expect(within(prefsCard).getByText('fintech')).toBeInTheDocument();
    expect(within(prefsCard).getByText('Senior')).toBeInTheDocument();

    const companiesCard = document.querySelector(
      '[data-qa="companies-avoid-card"]',
    ) as HTMLElement;
    expect(within(companiesCard).getByText('Acme Staffing')).toBeInTheDocument();
  });

  it('renders the empty-rules state when every title match/reject list is empty, and [Add] reveals + focuses one chip input', async () => {
    stubDocs({
      title: {
        domain: { match: [], reject: [], severity: 'hard' },
        function: { match: [], reject: [], severity: 'hard' },
        seniority: { match: [], reject: [], severity: 'hard' },
      },
    });
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('No rules — nothing is dropped for this reason');
    const rulesCard = document.querySelector(
      '[data-qa="roles-rules-card"]',
    ) as HTMLElement;
    await user.click(within(rulesCard).getByRole('button', { name: 'Add' }));

    expect(
      screen.queryByText('No rules — nothing is dropped for this reason'),
    ).not.toBeInTheDocument();
    const matchInput = screen.getByRole('textbox', { name: 'Add to Domain match' });
    expect(matchInput).toBeInTheDocument();
    expect(matchInput).toHaveFocus();
  });

  it('does not render the empty state once a title rule exists', async () => {
    stubDocs();
    renderSection();

    await screen.findByText('engineer');
    expect(
      screen.queryByText('No rules — nothing is dropped for this reason'),
    ).not.toBeInTheDocument();
  });

  it('adding a domain keyword, a seniority target and a companies-avoid entry saves both docs, preserving the point-weight fields', async () => {
    stubDocs();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();

    await user.type(
      await screen.findByRole('textbox', { name: 'Domain keyword preference' }),
      'saas',
    );
    await user.click(
      within(
        screen
          .getByRole('textbox', { name: 'Domain keyword preference' })
          .closest('div') as HTMLElement,
      ).getByRole('button', { name: 'Add' }),
    );

    await user.type(
      screen.getByRole('textbox', { name: 'Seniority target preference' }),
      'Staff',
    );
    await user.click(
      within(
        screen
          .getByRole('textbox', { name: 'Seniority target preference' })
          .closest('div') as HTMLElement,
      ).getByRole('button', { name: 'Add' }),
    );

    await user.type(
      screen.getByRole('textbox', { name: 'Companies to avoid' }),
      'Chargebee',
    );
    await user.click(
      within(
        screen
          .getByRole('textbox', { name: 'Companies to avoid' })
          .closest('div') as HTMLElement,
      ).getByRole('button', { name: 'Add' }),
    );

    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(configApi.putConfigDoc).mock.calls as [
      string,
      string,
      string,
    ][];
    const filterCall = calls.find((c) => c[1] === 'filter.json');
    const profileCall = calls.find((c) => c[1] === 'profile.json');
    // biome-ignore lint/style/noNonNullAssertion: both docs are asserted present above
    const writtenFilter = JSON.parse(filterCall![2]);
    // biome-ignore lint/style/noNonNullAssertion: both docs are asserted present above
    const writtenProfile = JSON.parse(profileCall![2]);

    expect(writtenFilter.companies.avoid).toEqual(['Acme Staffing', 'Chargebee']);
    expect(writtenProfile.settings.rank.title).toEqual({
      domainKeywords: ['fintech', 'saas'],
      maxPoints: 15,
      neutralPoints: 8,
    });
    expect(writtenProfile.settings.rank.seniority).toEqual({
      targets: ['Senior', 'Staff'],
      maxPoints: 15,
    });
    expect(writtenProfile.settings.rank.location).toEqual({ homeCities: ['Chennai'] });
  });
});
