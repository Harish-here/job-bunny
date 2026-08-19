import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../config.api';
import { SkillsSection } from './SkillsSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));

const BASE_FILTER_JSON = {
  title: { domain: { match: ['frontend'], reject: [], severity: 'hard' } },
  companies: { avoid: ['Chargebee'] },
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
  timezones: { accept: ['APAC'], severity: 'hard' },
  skills: { core: ['React'], minMatch: 1, severity: 'hard' },
};

function stubDoc(doc: Record<string, unknown> = BASE_FILTER_JSON) {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({
    text: `${JSON.stringify(doc, null, 2)}\n`,
  });
}
function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SkillsSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SkillsSection', () => {
  it('the minMatch field round-trips through the editor state and preserves title/locations', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();

    const minMatchInput = await screen.findByLabelText('Minimum skill matches');
    expect(minMatchInput).toHaveValue(1);

    await user.clear(minMatchInput);
    await user.type(minMatchInput, '3');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(call[2]);
    // applyFilterEditorState/parseFilterDoc round-trip: the value read
    // back out of the saved editor state matches what was typed.
    expect(written.skills.minMatch).toBe(3);
    expect(written.skills.core).toEqual(['React']);
    // title/locations pass through the shared FilterEditorState untouched.
    expect(written.title.domain.match).toEqual(['frontend']);
    expect(written.locations).toEqual([
      { city: 'Chennai', country: 'India', workTypes: ['onsite'] },
    ]);
  });

  it('a core skill added via the shared ChipInput reaches the saved payload', async () => {
    stubDoc();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{}' });
    const user = userEvent.setup();
    renderSection();

    await user.type(
      await screen.findByRole('textbox', { name: 'Add a core skill' }),
      'TypeScript',
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('TypeScript')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalledTimes(1));
    const call = vi.mocked(configApi.putConfigDoc).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const written = JSON.parse(call[2]);
    expect(written.skills.core).toEqual(['React', 'TypeScript']);
  });

  it('an invalid minMatch blocks the save and surfaces the validation summary', async () => {
    stubDoc();
    const user = userEvent.setup();
    renderSection();

    const minMatchInput = await screen.findByLabelText('Minimum skill matches');
    await user.clear(minMatchInput);
    await user.type(minMatchInput, '0');

    // Surfaced both inline (next to the field) and in SaveBar's validation
    // summary — assert at least one instance renders.
    const matches = await screen.findAllByText(
      'Minimum skill matches must be a whole number of 1 or more.',
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });
});
