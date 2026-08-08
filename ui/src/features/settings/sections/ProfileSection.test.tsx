import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../config.api';
import { ProfileSection } from './ProfileSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));

const BASE_PROFILE_JSON = {
  connector: 'sqlite',
  lanes: ['linkedin', 'a-future-lane'],
  notifiers: ['a-future-notifier'],
  routines: ['cleanup'],
  settings: { rank: { skills: { primary: ['React'] } } },
};

function stubDoc(doc: Record<string, unknown> = BASE_PROFILE_JSON) {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({
    text: `${JSON.stringify(doc, null, 2)}\n`,
  });
}

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ProfileSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProfileSection', () => {
  it("pre-fills its fields from the loaded doc's current values", async () => {
    stubDoc();
    renderSection();
    // Wait on a real load-transition signal, not the Connector select's
    // value — its default ('sqlite') equals the loaded value here, so a
    // `waitFor` keyed on it would pass trivially on the first synchronous
    // render without ever waiting for the async load.
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'linkedin' })).toBeChecked(),
    );
    expect(screen.getByLabelText('Connector')).toHaveValue('sqlite');
    expect(screen.getByRole('checkbox', { name: 'greenhouse' })).not.toBeChecked();
    expect(screen.getByText('cleanup')).toBeInTheDocument();
  });

  it('a save preserves unrelated keys and unknown lane/notifier entries', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'ok' });
    const user = userEvent.setup();
    renderSection();
    // See the same wait-condition note in the previous test.
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'linkedin' })).toBeChecked(),
    );
    await user.click(screen.getByRole('checkbox', { name: 'greenhouse' }));
    await user.click(screen.getByRole('checkbox', { name: 'Telegram notifier' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const [, , text] = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(text);
    expect([...written.lanes].sort()).toEqual([
      'a-future-lane',
      'greenhouse',
      'linkedin',
    ]);
    expect([...written.notifiers].sort()).toEqual(['a-future-notifier', 'telegram']);
    expect(written.settings).toEqual(BASE_PROFILE_JSON.settings);
    expect(written.routines).toEqual(['cleanup']);
  });

  it('renders a rejected save message inline', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockRejectedValue(
      new Error('profile.json is invalid: connector is required'),
    );
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => expect(screen.getByLabelText('Connector')).toHaveValue('sqlite'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('settings-error')).toHaveTextContent(
      'profile.json is invalid: connector is required',
    );
  });
});
