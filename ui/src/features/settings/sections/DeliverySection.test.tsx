import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../config.api';
import { DeliverySection } from './DeliverySection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));

const BASE_PROFILE_JSON = {
  connector: 'sqlite',
  lanes: ['linkedin'],
  notifiers: ['other'],
  routines: [],
  settings: { notion: { mirror: false, dryRun: true } },
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
  return render(<DeliverySection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DeliverySection', () => {
  it('renders the connector as read-only display, exposing no interactive role', async () => {
    stubDoc();
    renderSection();

    const field = await screen.findByTestId('delivery-connector-field');
    expect(within(field).getByText(/Connector: sqlite/)).toBeInTheDocument();
    // The proof this is genuinely display-only rather than a disabled
    // control: zero combobox AND zero button roles inside the field,
    // scoped so an unrelated Save/Discard button elsewhere can't mask it.
    expect(within(field).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(field).queryAllByRole('button')).toHaveLength(0);
  });

  it('toggling Notion mirror saves settings.notion.mirror while preserving dryRun and connector', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();

    const mirrorSwitch = await screen.findByRole('switch', { name: 'Mirror to Notion' });
    await user.click(mirrorSwitch);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(call[2]);
    expect(written.settings.notion.mirror).toBe(true);
    expect(written.settings.notion.dryRun).toBe(true);
    // Never writes connector back — the whole point of R11.
    expect(written.connector).toBe('sqlite');
  });

  it('enabling the Telegram notifier adds it to notifiers while preserving other entries', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('checkbox', { name: 'Telegram notifier' }));
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(call[2]);
    expect(written.notifiers).toEqual(['other', 'telegram']);
  });
});
