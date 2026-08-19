import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../../lib/router';
import * as configApi from '../config.api';
import { RawConfigSection } from './RawConfigSection';

vi.mock('../config.api', () => ({ getConfigDoc: vi.fn(), putConfigDoc: vi.fn() }));
vi.mock('../../../lib/router', () => ({ navigate: vi.fn() }));

function stubDocs(byDoc: Record<string, string> = {}) {
  vi.mocked(configApi.getConfigDoc).mockImplementation((_profile, doc) =>
    Promise.resolve({ text: byDoc[doc] ?? '' }),
  );
}

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...render(<RawConfigSection profile={profile} />, { wrapper }) };
}

function editor(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('[data-qa="raw-editor"]') as HTMLTextAreaElement;
}

function docRow(container: HTMLElement, dataQa: string): HTMLElement {
  return container.querySelector(`[data-qa="${dataQa}"]`) as HTMLElement;
}

// The row's own click target is the inner label `<button>` (the row `div`
// itself carries `data-qa` + the `bg-accent` active styling but no
// handler — see `RawConfigSection.tsx`'s doc comment on avoiding a
// button-inside-button a11y violation).
function selectDoc(container: HTMLElement, dataQa: string): HTMLElement {
  return docRow(container, dataQa).querySelector('button') as HTMLElement;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RawConfigSection', () => {
  it('defaults selectedDoc to profile.json, styling its row active, and loads its text', async () => {
    stubDocs({ 'profile.json': '{"connector":"sqlite"}' });
    const { container } = renderSection();

    await waitFor(() => expect(editor(container)).toHaveValue('{"connector":"sqlite"}'));

    expect(docRow(container, 'raw-doc-profile-json').className).toContain('bg-accent');
    expect(docRow(container, 'raw-doc-filter-json').className).not.toContain('bg-accent');
  });

  it('clicking a doc row switches the editor to that doc and moves the active style', async () => {
    stubDocs({
      'profile.json': '{"a":1}',
      'filter.json': '{"b":2}',
    });
    const user = userEvent.setup();
    const { container } = renderSection();

    await waitFor(() => expect(editor(container)).toHaveValue('{"a":1}'));
    await user.click(selectDoc(container, 'raw-doc-filter-json'));

    await waitFor(() => expect(editor(container)).toHaveValue('{"b":2}'));
    expect(docRow(container, 'raw-doc-filter-json').className).toContain('bg-accent');
    expect(docRow(container, 'raw-doc-profile-json').className).not.toContain(
      'bg-accent',
    );
  });

  it('renders the exact scope-banner copy', async () => {
    stubDocs();
    const { container } = renderSection();
    await waitFor(() => expect(editor(container)).toBeInTheDocument());
    const banner = container.querySelector('[data-qa="raw-scope-banner"]');
    expect(banner?.textContent).toBe(
      'Only these have no form: ranking point weights and denominators, registry health thresholds, adapter settings. Everything else on this page has one.',
    );
  });

  it('clicking raw-key-badge-schedule calls navigate to the schedule section', async () => {
    stubDocs({ 'profile.json': '{}' });
    const user = userEvent.setup();
    const { container } = renderSection();
    await waitFor(() => expect(editor(container)).toBeInTheDocument());

    await user.click(docRow(container, 'raw-key-badge-schedule'));
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'schedule',
    });
  });

  it('clicking raw-key-badge-locations/companies/lanes navigates to their owning sections', async () => {
    stubDocs({ 'profile.json': '{}', 'filter.json': '{}' });
    const user = userEvent.setup();
    const { container } = renderSection();
    await waitFor(() => expect(editor(container)).toBeInTheDocument());

    await user.click(docRow(container, 'raw-key-badge-locations'));
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'where-you-work' as never,
    });

    await user.click(docRow(container, 'raw-key-badge-companies'));
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'roles-companies' as never,
    });

    await user.click(docRow(container, 'raw-key-badge-lanes'));
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'where-jobs-come-from' as never,
    });
  });

  it('raw-key-badge-rank-weights has no click handler at all — no button/link role, absent onClick', async () => {
    stubDocs();
    const { container } = renderSection();
    await waitFor(() => expect(editor(container)).toBeInTheDocument());

    const badge = docRow(container, 'raw-key-badge-rank-weights');
    expect(badge).not.toBeNull();
    expect(badge.tagName).toBe('SPAN');
    expect(badge.hasAttribute('tabindex')).toBe(false);
    expect(badge.getAttribute('role')).toBeNull();
    // No button/link role reachable anywhere with this badge's own text.
    expect(screen.queryAllByRole('button', { name: 'raw only' })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'raw only' })).toHaveLength(0);

    // Clicking it is a genuine no-op: no navigate call, no thrown error.
    await userEvent.click(badge);
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });

  it('search_urls.md text is never JSON-parsed or JSON-validated — malformed markdown saves cleanly', async () => {
    stubDocs({ 'search_urls.md': '# not json at all\n- one\n- two' });
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: 'edited markdown' });
    const user = userEvent.setup();
    const { container } = renderSection();
    await waitFor(() => expect(editor(container)).toBeInTheDocument());
    await user.click(selectDoc(container, 'raw-doc-search-urls-md'));

    await waitFor(() =>
      expect(editor(container)).toHaveValue('# not json at all\n- one\n- two'),
    );
    await user.clear(editor(container));
    await user.type(editor(container), 'edited markdown');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'search_urls.md',
        'edited markdown',
      ),
    );
    expect(screen.queryByTestId('validation-summary')).not.toBeInTheDocument();
  });

  it('a fresh profile missing resume.json shows the empty-doc placeholder, and Save still creates it', async () => {
    stubDocs();
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '{"name":"x"}' });
    const user = userEvent.setup();
    const { container } = renderSection();
    await waitFor(() => expect(editor(container)).toBeInTheDocument());
    await user.click(selectDoc(container, 'raw-doc-resume-json'));

    await waitFor(() =>
      expect(editor(container)).toHaveAttribute(
        'placeholder',
        'Not created yet — saving will create it',
      ),
    );

    await user.type(editor(container), '{{"name":"x"}');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(configApi.putConfigDoc).toHaveBeenCalledWith(
        'rajni',
        'resume.json',
        '{"name":"x"}',
      ),
    );
  });

  it('a JSON parse error at save time renders in the SaveBar validation-summary, never a toast', async () => {
    stubDocs({ 'profile.json': '{"a":1}' });
    const user = userEvent.setup();
    const { container } = renderSection();
    await waitFor(() => expect(editor(container)).toHaveValue('{"a":1}'));

    await user.clear(editor(container));
    await user.type(editor(container), '{{"a": bad}');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    const summary = await screen.findByTestId('validation-summary');
    expect(summary).toBeInTheDocument();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });
});
