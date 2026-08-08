import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsSection } from '../../lib/router';
import * as configApi from './config.api';
import { SettingsPage } from './SettingsPage';

vi.mock('./config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../lib/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/router')>();
  return { ...actual, navigate: vi.fn() };
});

import { navigate } from '../../lib/router';

function stubGet(text = '{}') {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text });
}

function renderPage(section: SettingsSection = 'profile') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SettingsPage profile="rajni" section={section} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SettingsPage', () => {
  it('renders all six tabs in order with the frozen labels, and the section prop drives the active tab + data-section', () => {
    stubGet();
    renderPage('filters');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual([
      'Profile',
      'Schedule',
      'Filters',
      'Resume',
      'Search URLs',
      'Danger zone',
    ]);
    expect(screen.getByRole('tab', { name: 'Filters' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('settings-section')).toHaveAttribute(
      'data-section',
      'filters',
    );
  });

  it('selecting a tab navigates to that settings section', async () => {
    stubGet();
    const user = userEvent.setup();
    renderPage('profile');
    await user.click(screen.getByRole('tab', { name: 'Schedule' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings', section: 'schedule' });
  });

  it('the Profile tab renders the real ProfileSection form plus its JSON hatch, and Danger zone gets no hatch', async () => {
    stubGet('{"connector":"sqlite","lanes":[],"notifiers":[],"routines":[]}');
    const { unmount } = renderPage('profile');
    expect(await screen.findByLabelText('Connector')).toBeInTheDocument();
    expect(screen.getByTestId('settings-json-open')).toBeInTheDocument();
    unmount();

    stubGet();
    renderPage('danger');
    expect(screen.queryByTestId('settings-json-open')).not.toBeInTheDocument();
  });
});
