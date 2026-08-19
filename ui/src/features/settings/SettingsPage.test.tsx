import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsSection } from '../../lib/router';
import * as configApi from './config.api';
import { SettingsPage } from './SettingsPage';

vi.mock('./config.api', () => ({
  getConfigDoc: vi.fn(),
  putConfigDoc: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock('../../lib/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/router')>();
  return { ...actual, navigate: vi.fn() };
});

function stubGet(text = '{}') {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text });
}

function renderPage(section: SettingsSection) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SettingsPage profile="rajni" section={section} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

// Each case is a marker known to render unconditionally (not gated behind a
// data-shaped branch) for that section, so the test stays resilient to the
// generic '{}' doc stub every case shares — a selector where the section
// exposes one, otherwise a static heading/label string.
type Marker = { selector: string } | { text: string };
const CASES: { section: SettingsSection; marker: Marker }[] = [
  { section: 'landing', marker: { selector: '[data-qa="landing-thin-run"]' } },
  { section: 'roles-companies', marker: { selector: '[data-qa="roles-rules-card"]' } },
  { section: 'where-you-work', marker: { selector: '[data-qa="geo-rules-card"]' } },
  { section: 'skills', marker: { text: 'Skills — a job that fails this is dropped' } },
  { section: 'about-you', marker: { text: 'Current years of experience' } },
  {
    section: 'where-jobs-come-from',
    marker: { selector: '[data-qa="where-jobs-lanes-card"]' },
  },
  { section: 'schedule', marker: { selector: '[data-testid="schedule-next-run"]' } },
  { section: 'fetching', marker: { selector: '[data-qa="fetch-caps-card"]' } },
  { section: 'delivery', marker: { selector: '[data-qa="delivery-connector-card"]' } },
  { section: 'housekeeping', marker: { selector: '[data-qa="cleanup-ttls-card"]' } },
  { section: 'raw-config', marker: { selector: '[data-qa="raw-scope-banner"]' } },
  { section: 'danger', marker: { selector: '[data-testid="danger-open"]' } },
];

describe('SettingsPage', () => {
  it.each(CASES)(
    'section="$section" mounts its corresponding component and carries data-section',
    async ({ section, marker }) => {
      stubGet();
      renderPage(section);
      expect(screen.getByTestId('settings-section')).toHaveAttribute(
        'data-section',
        section,
      );
      if ('selector' in marker) {
        await waitFor(() =>
          expect(document.querySelector(marker.selector)).toBeInTheDocument(),
        );
      } else {
        await screen.findByText(marker.text);
      }
    },
  );

  it('renders the shared Settings heading and the settings-shell region', () => {
    stubGet();
    renderPage('landing');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
    expect(document.querySelector('[data-qa="settings-shell"]')).toBeInTheDocument();
  });
});
