import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as draftStore from './draftStore';
import { WizardPage } from './WizardPage';
import { emptyDraft, type WizardDraft } from './wizard.types';

vi.mock('./draftStore', () => ({
  readActiveProfile: vi.fn(),
  readDraft: vi.fn(),
  writeDraft: vi.fn(),
  clearDraft: vi.fn(),
}));

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

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('WizardPage', () => {
  it('rehydrates the step from a stored draft for the active profile', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue('wiz-existing');
    stubProfilesFetch([{ name: 'wiz-existing', connector: 'sqlite', hasDb: true }]);
    const stored: WizardDraft = { ...emptyDraft('wiz-existing'), step: 4 };
    vi.mocked(draftStore.readDraft).mockReturnValue(stored);

    renderWizard();

    await waitFor(() => {
      expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '4');
    });
    const panel = screen.getByTestId('wizard-step');
    expect(
      within(panel).getByRole('heading', { name: 'Where to hunt' }),
    ).toBeInTheDocument();
  });

  it('discards a draft whose profile no longer exists and starts at step 1', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue('ghost');
    stubProfilesFetch([{ name: 'rajni', connector: 'sqlite', hasDb: true }]);

    renderWizard();

    await waitFor(() => {
      expect(draftStore.clearDraft).toHaveBeenCalledWith('ghost');
    });
    const panel = screen.getByTestId('wizard-step');
    expect(panel).toHaveAttribute('data-step', '1');
    expect(within(panel).getByRole('heading', { name: 'Name it' })).toBeInTheDocument();
  });

  it('Next advances through the placeholder steps and Back returns, writing nothing to localStorage while draft.profile is still empty', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue(null);
    stubProfilesFetch([]);

    renderWizard();

    await screen.findByTestId('wizard-next');
    expect(screen.queryByTestId('wizard-back')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '2');
    });
    expect(screen.getByTestId('wizard-back')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('wizard-back'));
    expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '1');

    // draft.profile is still '' at this point — no step has created a
    // profile yet, since every step is a placeholder — so writeDraft is
    // never called, per the frozen "a draft key always names a real
    // profile" localStorage rule.
    expect(draftStore.writeDraft).not.toHaveBeenCalled();
  });

  it('wizard-next is disabled on step 6, the only exit, once every earlier placeholder has been passed through', async () => {
    vi.mocked(draftStore.readActiveProfile).mockReturnValue(null);
    stubProfilesFetch([]);

    renderWizard();

    await screen.findByTestId('wizard-next');
    for (let i = 1; i < 6; i++) {
      await userEvent.click(screen.getByTestId('wizard-next'));
      await waitFor(() => {
        expect(screen.getByTestId('wizard-step')).toHaveAttribute(
          'data-step',
          String(i + 1),
        );
      });
    }
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
  });
});
