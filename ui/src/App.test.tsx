import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App';

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/profiles')) {
        return {
          ok: true,
          json: async () => ({
            profiles: [{ name: 'rajni', connector: 'sqlite', hasDb: true }],
          }),
        } as unknown as Response;
      }
      if (url.includes('/api/app')) {
        return {
          ok: true,
          json: async () => ({ version: '2.1.0' }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  window.location.hash = '';
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('renders the app shell', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(screen.getByText(/job bunny/i)).toBeInTheDocument();
  });
});
