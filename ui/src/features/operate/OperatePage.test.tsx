import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OperatePage } from './OperatePage';

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

/** Stubs the four independent GETs `OperatePage`'s cards each self-fetch —
 * mirrors `HubPage.test.tsx`'s (now-deleted) `stubFetch` idiom, extended
 * for `/api/secrets`, which `SecretsCard` reads directly with no
 * dedicated `*.api.ts` wrapper. */
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/doctor')) {
        return {
          ok: true,
          json: async () => ({ status: 'ok', findings: [] }),
        } as unknown as Response;
      }
      if (url.includes('/api/daemon')) {
        return {
          ok: true,
          json: async () => ({
            state: 'running',
            pid: 59025,
            startedAt: null,
            lastTickAt: null,
            inFlight: null,
            profiles: [],
          }),
        } as unknown as Response;
      }
      if (url.includes('/config/profile.json')) {
        return {
          ok: true,
          json: async () => ({ text: JSON.stringify({ schedule: { enabled: false } }) }),
        } as unknown as Response;
      }
      if (url.includes('/api/secrets')) {
        return {
          ok: true,
          json: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<OperatePage profile="rajni" />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OperatePage', () => {
  it('renders the shell, the scope chip, and the four cards — no card-linkedin', async () => {
    stubFetch();
    const { container } = renderPage();

    expect(container.querySelector('[data-qa="operate-shell"]')).not.toBeNull();
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="scope-chip-machine"]')).not.toBeNull();

    await screen.findByText('Running'); // daemon settles last of the four
    for (const id of [
      'card-daemon',
      'card-scheduled-runs',
      'card-setup-health',
      'card-secrets',
    ]) {
      expect(container.querySelector(`[data-qa="${id}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-qa="card-linkedin"]')).toBeNull();
  });

  it("one card's error state never blanks the others — daemon-scoped cards keep rendering when secrets fail", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/secrets')) {
          return { ok: false, json: async () => ({}) } as unknown as Response;
        }
        if (url.includes('/doctor')) {
          return {
            ok: true,
            json: async () => ({ status: 'ok', findings: [] }),
          } as unknown as Response;
        }
        if (url.includes('/api/daemon')) {
          return {
            ok: true,
            json: async () => ({
              state: 'running',
              pid: 1,
              startedAt: null,
              lastTickAt: null,
              inFlight: null,
              profiles: [],
            }),
          } as unknown as Response;
        }
        if (url.includes('/config/profile.json')) {
          return { ok: true, json: async () => ({ text: '{}' }) } as unknown as Response;
        }
        throw new Error(`unexpected fetch url: ${url}`);
      }) as unknown as typeof fetch,
    );
    const { container } = renderPage();

    await screen.findByText("Can't reach the secrets API");
    expect(container.querySelector('[data-qa="card-daemon"]')).not.toBeNull();
    await screen.findByText('Running');
  });
});
