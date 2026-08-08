/**
 * WizardPage.completion.test.tsx — regression coverage for item 3 (fix
 * round 2): a completed wizard must stay cleared. Deliberately does NOT
 * mock `./draftStore`, unlike `WizardPage.test.tsx` — it exercises the
 * real module against jsdom's real `localStorage`, because the bug this
 * guards against is specifically about `draftStore`'s own persisted state
 * (the per-profile draft key and the `jobbunny.wizard.active` pointer)
 * surviving a completed wizard's own `clearDraft` call, which a mocked
 * `draftStore` can't observe. Colocated as its own file rather than a case
 * inside `WizardPage.test.tsx` for the same reason `JobPage.reading.test.tsx`
 * sits beside `JobPage.test.tsx`: a real vs. mocked dependency is a natural
 * file seam, not something to thread through one shared `vi.mock`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as draftStore from './draftStore';
import { WizardPage } from './WizardPage';
import * as wizardApi from './wizard.api';
import { emptyDraft } from './wizard.types';

vi.mock('./wizard.api', () => ({
  getPersonas: vi.fn(),
  getDaemonStatus: vi.fn(),
  patchProfileConfig: vi.fn(),
  requestRunIntent: vi.fn(),
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('WizardPage completion', () => {
  it(
    'a completed step-6 submit clears the draft key and the active-draft pointer, ' +
      "and WizardPage's own clamped Next handling does not resurrect either afterward",
    async () => {
      const profile = 'wiz-completion';
      // Seed a real, resumable draft at step 6 through the real draftStore,
      // exactly as a browser reload mid-wizard would have left it.
      draftStore.writeDraft({ ...emptyDraft(profile), step: 6 });
      expect(draftStore.readDraft(profile)).not.toBeNull();
      expect(draftStore.readActiveProfile()).toBe(profile);

      stubProfilesFetch([{ name: profile, connector: 'sqlite', hasDb: true }]);
      vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue({
        state: 'stopped',
        pid: null,
        startedAt: null,
        lastTickAt: null,
        inFlight: null,
        profiles: [],
      });
      vi.mocked(wizardApi.patchProfileConfig).mockResolvedValue(undefined);

      renderWizard();

      await waitFor(() => {
        expect(screen.getByTestId('wizard-step')).toHaveAttribute('data-step', '6');
      });

      await userEvent.click(screen.getByTestId('wizard-next'));

      await waitFor(() => {
        expect(wizardApi.patchProfileConfig).toHaveBeenCalled();
      });

      // Step6Launch's own submit already calls clearDraft(profile). The
      // assertion here is that it STAYS cleared — i.e. WizardPage's
      // handleNext, which still fires after the submit resolves `true`,
      // does not write the draft back via its own clamped step-advance
      // side effect.
      expect(draftStore.readDraft(profile)).toBeNull();
      expect(draftStore.readActiveProfile()).toBeNull();
    },
  );
});
