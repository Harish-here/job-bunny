import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RulePreviewStrip } from './RulePreviewStrip';
import type { RolesCompaniesEditorState } from './rolesCompanies.model';

const DRAFT: RolesCompaniesEditorState = {
  title: {
    domain: { match: ['engineer'], reject: [], severity: 'hard' },
    function: { match: [], reject: [], severity: 'hard' },
    seniority: { match: [], reject: [], severity: 'hard' },
  },
  domainKeywords: ['fintech'],
  seniorityTargets: ['Senior'],
  companiesAvoid: ['Acme Staffing'],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RulePreviewStrip', () => {
  it('is not mounted at all before the preview request has resolved', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(<RulePreviewStrip profile="rajni" draft={DRAFT} />);
    expect(document.querySelector('[data-qa="rule-preview-strip"]')).toBeNull();
  });

  it('POSTs the draft filter.json shape (title + companies, not the profile.json prefs fields)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ available: false, reason: 'no_recent_run' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RulePreviewStrip profile="rajni" draft={DRAFT} />);

    await screen.findByText('No recent run to preview against.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/profiles/rajni/preview/filter');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      title: {
        domain: { match: ['engineer'], reject: [], severity: 'hard' },
        function: { match: [], reject: [], severity: 'hard' },
        seniority: { match: [], reject: [], severity: 'hard' },
      },
      companies: { avoid: ['Acme Staffing'] },
    });
    expect(body.domainKeywords).toBeUndefined();
    expect(body.seniorityTargets).toBeUndefined();
  });

  it('renders counts and an expandable disclosure when available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          available: true,
          totalJobs: 214,
          baselineDrops: 189,
          draftDrops: 201,
          newlyDropped: [
            { title: 'Backend Engineer', company: 'Acme' },
            { title: 'Platform Engineer', company: 'Widgets Inc' },
          ],
        }),
      ),
    );
    render(<RulePreviewStrip profile="rajni" draft={DRAFT} />);

    const strip = await screen.findByText(/would drop/);
    expect(strip.textContent).toContain('214 jobs');
    expect(strip.textContent).toContain('201');
    expect(strip.textContent).toContain('12 more than the current one');

    expect(screen.queryByText('Backend Engineer — Acme')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'see which 2 →' });
    await userEvent.click(toggle);
    expect(screen.getByText('Backend Engineer — Acme')).toBeTruthy();
    expect(screen.getByText('Platform Engineer — Widgets Inc')).toBeTruthy();
  });

  it('renders the muted one-liner when available is false, reason no_recent_run', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ available: false, reason: 'no_recent_run' })),
    );
    render(<RulePreviewStrip profile="rajni" draft={DRAFT} />);

    const strip = await screen.findByText('No recent run to preview against.');
    expect(strip.getAttribute('data-qa')).toBe('rule-preview-strip');
  });
});
