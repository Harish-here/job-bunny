import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from './config.api';
import { JsonEscapeHatch } from './JsonEscapeHatch';

vi.mock('./config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));

function renderHatch(
  profile = 'rajni',
  doc: 'profile.json' | 'filter.json' = 'filter.json',
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<JsonEscapeHatch profile={profile} doc={doc} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('JsonEscapeHatch', () => {
  it('seeds the textarea from the loaded doc, then PUTs an edit and closes on success', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '{"a":1}' });
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{"a":2}' });
    const user = userEvent.setup();
    renderHatch('rajni', 'filter.json');
    await user.click(screen.getByTestId('settings-json-open'));
    const textarea = await screen.findByTestId('settings-json-textarea');
    await waitFor(() => expect(textarea).toHaveValue('{"a":1}'));
    await user.clear(textarea);
    await user.type(textarea, '{{"a":2}');
    await user.click(screen.getByTestId('settings-json-save'));
    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'filter.json',
        '{"a":2}',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it("a server rejection renders the message inline and never stomps the user's edit", async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '{"a":1}' });
    vi.mocked(configApi.putConfigDoc).mockRejectedValue(
      new Error('filter.json is invalid: unexpected token'),
    );
    const user = userEvent.setup();
    renderHatch();
    await user.click(screen.getByTestId('settings-json-open'));
    const textarea = await screen.findByTestId('settings-json-textarea');
    await user.clear(textarea);
    await user.type(textarea, '{{not valid json');
    await user.click(screen.getByTestId('settings-json-save'));
    expect(
      await screen.findByText('filter.json is invalid: unexpected token'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('settings-json-textarea')).toHaveValue('{not valid json');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
