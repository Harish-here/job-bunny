import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../runs/runs.api';
import * as configApi from '../config.api';
import { WhereYouWorkSection } from './WhereYouWorkSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));

// Each ChipInput renders its own "Add" button beside its own input — scope
// to the specific field's own input+Add wrapper rather than index-guessing
// across getAllByRole('button', { name: 'Add' }).
function addButtonFor(inputLabel: string): HTMLElement {
  const input = screen.getByRole('textbox', { name: inputLabel });
  // biome-ignore lint/style/noNonNullAssertion: ChipInput always wraps its input+Add in a parent div
  return within(input.closest('div')!).getByRole('button', { name: 'Add' });
}

const BASE_FILTER = {
  title: { domain: { match: [], reject: [], severity: 'hard' } },
  companies: { avoid: [] },
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
  timezones: { accept: ['APAC'], severity: 'hard' },
  skills: { core: [], minMatch: 1, severity: 'hard' },
};
const BASE_PROFILE = {
  settings: {
    rank: {
      location: {
        homeCities: ['Chennai'],
        acceptableTimezones: ['APAC'],
        borderlineTimezones: [],
        bonus: 20,
        partial: 10,
      },
      workTypePreference: { onsite: 1, hybrid: 1, remote: 1 },
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
  return render(<WhereYouWorkSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WhereYouWorkSection', () => {
  it('renders both cards, in fixed order, with the connective line between them and no conflict notice when nothing conflicts', async () => {
    stubDocs();
    renderSection();

    await screen.findByText('Rules — a job that fails these is dropped');
    expect(
      screen.getByText('Preferences — these change the order, never drop anything'),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-qa="geo-connective-line"]')).not.toBeNull();
    expect(document.querySelector('[data-qa="geo-conflict-notice"]')).toBeNull();

    const rulesCard = document.querySelector('[data-qa="geo-rules-card"]');
    const connective = document.querySelector('[data-qa="geo-connective-line"]');
    const prefsCard = document.querySelector('[data-qa="geo-prefs-card"]');
    // DOM order matches the fixed card order the brief mandates.
    // biome-ignore lint/style/noNonNullAssertion: presence already asserted above
    expect(
      rulesCard!.compareDocumentPosition(connective!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // biome-ignore lint/style/noNonNullAssertion: presence already asserted above
    expect(
      connective!.compareDocumentPosition(prefsCard!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the hard-severity conflict copy + both actions when the rule drops an acceptable timezone', async () => {
    stubDocs(
      { timezones: { accept: ['APAC'], severity: 'hard' } },
      {
        settings: {
          rank: {
            location: {
              homeCities: [],
              acceptableTimezones: ['APAC', 'America/New_York'],
              borderlineTimezones: [],
            },
            workTypePreference: { onsite: 1, hybrid: 1, remote: 1 },
          },
        },
      },
    );
    renderSection();

    await waitFor(() =>
      expect(document.querySelector('[data-qa="geo-conflict-notice"]')).not.toBeNull(),
    );
    const notice = document.querySelector('[data-qa="geo-conflict-notice"]');
    expect(notice?.textContent).toContain('America/New_York');
    expect(notice?.textContent).toContain('so no job from it can reach the board');
    expect(screen.getByRole('button', { name: 'Add to rule' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove from preference' }),
    ).toBeInTheDocument();
  });

  it('renders the soft-severity conflict copy with no actions', async () => {
    stubDocs(
      { timezones: { accept: ['APAC'], severity: 'soft' } },
      {
        settings: {
          rank: {
            location: {
              homeCities: [],
              acceptableTimezones: ['APAC', 'America/New_York'],
              borderlineTimezones: [],
            },
            workTypePreference: { onsite: 1, hybrid: 1, remote: 1 },
          },
        },
      },
    );
    renderSection();

    await waitFor(() =>
      expect(document.querySelector('[data-qa="geo-conflict-notice"]')).not.toBeNull(),
    );
    const notice = document.querySelector('[data-qa="geo-conflict-notice"]');
    expect(notice?.textContent).toContain('America/New_York');
    expect(notice?.textContent).toContain('it still reaches the board, ranked lower');
    expect(notice?.textContent).not.toContain('so no job from it can reach the board');
    expect(screen.queryByRole('button', { name: 'Add to rule' })).not.toBeInTheDocument();
  });

  it('renders the empty-rules-list state and seeds one LocationRow on [Add]', async () => {
    stubDocs({ locations: [], timezones: undefined });
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('No rules — nothing is dropped for this reason');
    const rulesCard = document.querySelector('[data-qa="geo-rules-card"]') as HTMLElement;
    await user.click(within(rulesCard).getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Location city')).toBeInTheDocument();
  });

  it('once the conflict notice is present and the draft becomes dirty, the save button steps back to the outline variant', async () => {
    stubDocs(
      { timezones: { accept: ['APAC'], severity: 'hard' } },
      {
        settings: {
          rank: {
            location: {
              homeCities: [],
              acceptableTimezones: ['APAC', 'America/New_York'],
              borderlineTimezones: [],
            },
            workTypePreference: { onsite: 1, hybrid: 1, remote: 1 },
          },
        },
      },
    );
    const user = userEvent.setup();
    renderSection();

    await waitFor(() =>
      expect(document.querySelector('[data-qa="geo-conflict-notice"]')).not.toBeNull(),
    );
    const homeCityInput = screen.getByRole('textbox', { name: 'Home cities preference' });
    await user.type(homeCityInput, 'Chennai');
    await user.click(addButtonFor('Home cities preference'));

    const saveButton = await screen.findByTestId('save-button');
    expect(saveButton).toHaveAttribute('data-variant', 'outline');
    expect(saveButton).not.toBeDisabled();
  });
});
