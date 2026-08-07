import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import * as configApi from '../settings/config.api';
import * as draftStore from './draftStore';
import { WizardPage } from './WizardPage';
import * as wizardApi from './wizard.api';
import { emptyDraft, type Persona, type WizardDraft } from './wizard.types';

vi.mock('./draftStore', () => ({
  readActiveProfile: vi.fn(),
  readDraft: vi.fn(),
  writeDraft: vi.fn(),
  clearDraft: vi.fn(),
}));
vi.mock('../settings/config.api', () => ({
  createProfile: vi.fn(),
}));
vi.mock('./wizard.api', () => ({
  getPersonas: vi.fn(),
}));

const FRONTEND: Persona = {
  id: 'frontend',
  label: 'Frontend',
  blurb: 'Frontend engineering roles.',
  coreSkills: ['React', 'TypeScript'],
  secondarySkills: ['Vue.js'],
  seniorityOptions: ['Staff', 'Lead'],
  title: {
    domain: { match: ['frontend'], reject: [] },
    function: { match: ['engineer'], reject: [] },
  },
};
const CATALOG = { version: 1, personas: [FRONTEND] };

function stubProfilesFetch(
  profiles: { name: string; connector: 'sqlite'; hasDb: boolean }[],
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/profiles')) {
        return { ok: true, json: async () => ({ profiles }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

function renderWizard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<WizardPage />, { wrapper });
}

beforeEach(() => {
  vi.mocked(wizardApi.getPersonas).mockResolvedValue(CATALOG);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('WizardPage', () => {
  it('rehydrates step and answers from a stored draft for the active profile', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue('wiz-existing');
    stubProfilesFetch([{ name: 'wiz-existing', connector: 'sqlite', hasDb: true }]);
    const stored: WizardDraft = { ...emptyDraft('wiz-existing'), personaId: 'frontend' };
    vi.mocked(draftStore.readDraft).mockReturnValue(stored);

    renderWizard();

    await waitFor(() => {
      expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '2');
    });
    const cards = await screen.findAllByTestId('wizard-persona');
    const frontendCard = cards.find(
      (c) => c.getAttribute('data-persona-id') === 'frontend',
    );
    expect(frontendCard).toHaveAttribute('aria-pressed', 'true');
  });

  it('discards a draft whose profile no longer exists and starts at step 1', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue('ghost');
    stubProfilesFetch([{ name: 'rajni', connector: 'sqlite', hasDb: true }]);

    renderWizard();

    await waitFor(() => {
      expect(draftStore.clearDraft).toHaveBeenCalledWith('ghost');
    });
    expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '1');
    expect(screen.getByLabelText('Profile name')).toHaveValue('');
  });

  it('Back preserves the persona answer when returning to step 2', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue(null);
    stubProfilesFetch([]);
    vi.mocked(configApi.createProfile).mockResolvedValue({
      profile: { name: 'newwiz', connector: 'sqlite', hasDb: true },
    });

    renderWizard();

    const input = await screen.findByLabelText('Profile name');
    await userEvent.type(input, 'newwiz');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '2');
    });

    let cards = await screen.findAllByTestId('wizard-persona');
    let frontendCard = cards.find(
      (c) => c.getAttribute('data-persona-id') === 'frontend',
    );
    if (!frontendCard) throw new Error('frontend card not found');
    await userEvent.click(frontendCard);
    await waitFor(() => {
      const refreshed = screen
        .getAllByTestId('wizard-persona')
        .find((c) => c.getAttribute('data-persona-id') === 'frontend');
      expect(refreshed).toHaveAttribute('aria-pressed', 'true');
    });

    await userEvent.click(screen.getByTestId('wizard-back'));
    expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '1');

    await userEvent.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '2');
    });
    cards = await screen.findAllByTestId('wizard-persona');
    frontendCard = cards.find((c) => c.getAttribute('data-persona-id') === 'frontend');
    expect(frontendCard).toHaveAttribute('aria-pressed', 'true');
    // Only one createProfile call across the whole Back/Next round trip —
    // Back never re-runs a write, and revisiting step 1 with a profile
    // already created just navigates forward again.
    expect(configApi.createProfile).toHaveBeenCalledTimes(1);
  });

  it('renders an ApiError message verbatim in the step-level alert', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue(null);
    stubProfilesFetch([]);
    vi.mocked(configApi.createProfile).mockRejectedValue(
      new ApiError(500, 'internal', "The board couldn't be reached."),
    );

    renderWizard();

    const input = await screen.findByLabelText('Profile name');
    await userEvent.type(input, 'newwiz');
    await userEvent.click(screen.getByTestId('wizard-next'));

    expect(await screen.findByTestId('wizard-error')).toHaveTextContent(
      "The board couldn't be reached.",
    );
    expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '1');
  });
});
