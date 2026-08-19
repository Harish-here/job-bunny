import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../../lib/router';
import * as configApi from '../config.api';
import { LandingRulesSummary } from './LandingRulesSummary';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn() }));
vi.mock('../../../lib/router', () => ({ navigate: vi.fn() }));

const FILTER_JSON = {
  title: {
    domain: { match: ['fintech'], reject: [], severity: 'hard' },
    function: { match: ['engineering'], reject: [], severity: 'hard' },
    seniority: { match: ['staff'], reject: [], severity: 'soft' },
  },
  companies: { avoid: [] },
  locations: [{ city: 'Bengaluru', country: 'IN', workTypes: ['remote'] }],
  timezones: { accept: ['APAC'], severity: 'hard' },
  skills: { core: ['typescript', 'react'], minMatch: 1, severity: 'hard' },
};

function stubDocs(filterDoc: Record<string, unknown> = FILTER_JSON) {
  vi.mocked(configApi.getConfigDoc).mockImplementation((_profile, doc) => {
    if (doc === 'filter.json') {
      return Promise.resolve({ text: JSON.stringify(filterDoc) });
    }
    return Promise.resolve({ text: JSON.stringify({}) });
  });
}

function renderSummary(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<LandingRulesSummary profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LandingRulesSummary', () => {
  it('renders "3 active rules, 2 of them hard" on the Roles & companies row, counted from the fixture at render time', async () => {
    stubDocs();
    const { container } = renderSummary();

    await screen.findByText('3 active rules, 2 of them hard');
    const label = screen.getByText('Roles & companies');
    const row = label.closest('tr') as HTMLElement;
    expect(row.textContent).toContain('3 active rules, 2 of them hard');
    expect(container.querySelector('[data-qa="landing-rules-summary"]')).not.toBeNull();
  });

  it("renders all three rows in the fixed order: Roles & companies, Where you'll work, Skills", async () => {
    stubDocs();
    renderSummary();
    await screen.findByText('3 active rules, 2 of them hard');

    const labels = screen
      .getAllByRole('row')
      .map((row) => row.querySelector('td')?.textContent);
    expect(labels).toEqual(['Roles & companies', "Where you'll work", 'Skills']);
  });

  it("each row's [Open →] navigates to its owning section", async () => {
    stubDocs();
    renderSummary();
    await screen.findByText('3 active rules, 2 of them hard');

    const buttons = screen.getAllByRole('button', { name: 'Open →' });
    expect(buttons).toHaveLength(3);

    await userEvent.click(buttons[0] as HTMLElement);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'roles-companies' as never,
    });

    await userEvent.click(buttons[1] as HTMLElement);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'where-you-work' as never,
    });

    await userEvent.click(buttons[2] as HTMLElement);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'skills' as never,
    });
  });
});
