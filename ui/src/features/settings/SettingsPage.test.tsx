import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from './config.api';
import { SettingsPage } from './SettingsPage';

vi.mock('./config.api', () => ({
  getConfigDoc: vi.fn(),
  putConfigDoc: vi.fn(),
}));

const DOCS = ['profile.json', 'filter.json', 'resume.json', 'search_urls.md'] as const;

function docsFor(profile: string): Record<string, string> {
  return {
    'profile.json': `{"profile":"${profile}"}`,
    'filter.json': `{"filter":"${profile}"}`,
    'resume.json': `{"resume":"${profile}"}`,
    'search_urls.md': `# urls for ${profile}`,
  };
}

function stubGet(byProfile: Record<string, Record<string, string>>) {
  vi.mocked(configApi.getConfigDoc).mockImplementation(async (profile, doc) => ({
    text: byProfile[profile]?.[doc] ?? '',
  }));
}

function renderPage(profile: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SettingsPage profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SettingsPage', () => {
  it("loads and displays each doc's current text", async () => {
    stubGet({ rajni: docsFor('rajni') });
    renderPage('rajni');

    for (const doc of DOCS) {
      await waitFor(() => {
        expect(screen.getByLabelText(doc)).toHaveValue(docsFor('rajni')[doc]);
      });
    }
  });

  it('edits + Save calls putConfigDoc with the right args', async () => {
    stubGet({ rajni: docsFor('rajni') });
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'new filter text' });
    renderPage('rajni');

    const filterField = await screen.findByLabelText('filter.json');
    await waitFor(() => expect(filterField).toHaveValue(docsFor('rajni')['filter.json']));

    await userEvent.clear(filterField);
    await userEvent.type(filterField, 'new filter text');

    await userEvent.click(screen.getByRole('button', { name: 'Save filter.json' }));

    await waitFor(() => {
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'filter.json',
        'new filter text',
      );
    });
  });

  it('renders a rejected mutation error message somewhere visible', async () => {
    stubGet({ rajni: docsFor('rajni') });
    vi.mocked(configApi.putConfigDoc).mockRejectedValue(
      new Error('profile.json is invalid: expected object'),
    );
    renderPage('rajni');

    const field = await screen.findByLabelText('profile.json');
    await waitFor(() => expect(field).toHaveValue(docsFor('rajni')['profile.json']));

    await userEvent.click(screen.getByRole('button', { name: 'Save profile.json' }));

    expect(
      await screen.findByText('profile.json is invalid: expected object'),
    ).toBeInTheDocument();
  });

  it("switching profile resets all four drafts to the new profile's own values", async () => {
    stubGet({ rajni: docsFor('rajni'), harish: docsFor('harish') });
    const { rerender } = renderPage('rajni');

    await waitFor(() => {
      expect(screen.getByLabelText('profile.json')).toHaveValue(
        docsFor('rajni')['profile.json'],
      );
    });

    // Edit rajni's profile.json without saving.
    const field = screen.getByLabelText('profile.json');
    await userEvent.type(field, ' EDITED');
    expect(field).toHaveValue(`${docsFor('rajni')['profile.json']} EDITED`);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <SettingsPage profile="harish" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('profile.json')).toHaveValue(
        docsFor('harish')['profile.json'],
      );
    });
    await waitFor(() => {
      for (const doc of DOCS) {
        expect(screen.getByLabelText(doc)).toHaveValue(docsFor('harish')[doc]);
      }
    });
  });

  it('shows a Skeleton while the initial value is loading', () => {
    vi.mocked(configApi.getConfigDoc).mockImplementation(() => new Promise(() => {}));
    const { container } = renderPage('rajni');

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    expect(screen.queryByLabelText('profile.json')).not.toBeInTheDocument();
  });
});
