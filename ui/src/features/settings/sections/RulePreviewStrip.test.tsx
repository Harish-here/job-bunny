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

// A realistic stored filter.json — has a `locations` rule, same as every
// real profile does (`filter.json`'s `locations[]` is the sole geo
// authority, CLAUDE.md) — plus a DIFFERENT title/companies than `DRAFT`
// above, so the test can tell "carried over from baseDoc" apart from
// "overwritten by the draft".
const BASE_DOC: Record<string, unknown> = {
  locations: [{ mode: 'accept', values: ['Bengaluru', 'Remote'] }],
  timezones: { accept: ['Asia/Kolkata'] },
  skills: { required: ['TypeScript'] },
  title: {
    domain: { match: ['old-domain'], reject: [], severity: 'hard' },
    function: { match: [], reject: [], severity: 'hard' },
    seniority: { match: [], reject: [], severity: 'hard' },
  },
  companies: { avoid: ['Old Co'] },
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
    render(<RulePreviewStrip profile="rajni" baseDoc={BASE_DOC} draft={DRAFT} />);
    expect(document.querySelector('[data-qa="rule-preview-strip"]')).toBeNull();
  });

  it('POSTs the FULL loaded filter.json — draft title/companies applied on top, every other section (locations/timezones/skills) carried over unchanged, never the profile.json prefs fields (cross-check against board_preview.ts, which evaluates the draft STANDALONE and drops any rule whose config section is absent)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ available: false, reason: 'no_recent_run' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RulePreviewStrip profile="rajni" baseDoc={BASE_DOC} draft={DRAFT} />);

    await screen.findByText('No recent run to preview against.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/profiles/rajni/preview/filter');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      // Carried over from `baseDoc`, untouched by the draft.
      locations: [{ mode: 'accept', values: ['Bengaluru', 'Remote'] }],
      timezones: { accept: ['Asia/Kolkata'] },
      skills: { required: ['TypeScript'] },
      // Overwritten by the draft.
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

  it('never mutates the caller-supplied baseDoc object', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ available: false, reason: 'no_recent_run' })),
    );
    const original = structuredClone(BASE_DOC);
    render(<RulePreviewStrip profile="rajni" baseDoc={BASE_DOC} draft={DRAFT} />);
    await screen.findByText('No recent run to preview against.');
    expect(BASE_DOC).toEqual(original);
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
    render(<RulePreviewStrip profile="rajni" baseDoc={BASE_DOC} draft={DRAFT} />);

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
    render(<RulePreviewStrip profile="rajni" baseDoc={BASE_DOC} draft={DRAFT} />);

    const strip = await screen.findByText('No recent run to preview against.');
    expect(strip.getAttribute('data-qa')).toBe('rule-preview-strip');
  });

  // Re-review finding: `RolesCompaniesSection`'s real `baseDoc` prop
  // (`useDocForm.value`) is a fresh `JSON.parse` every render, so an
  // unrelated re-render that passes a content-EQUAL but reference-DIFFERENT
  // `baseDoc`/`draft` must not refire the debounced preview POST.
  it('a rerender with content-equal but reference-different baseDoc/draft does not refetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ available: false, reason: 'no_recent_run' }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(
      <RulePreviewStrip profile="rajni" baseDoc={BASE_DOC} draft={DRAFT} />,
    );
    await screen.findByText('No recent run to preview against.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same content, fresh object/array identities throughout — mirrors
    // what a real `JSON.parse` re-run and a fresh draft-state spread
    // actually produce on an unrelated re-render.
    rerender(
      <RulePreviewStrip
        profile="rajni"
        baseDoc={structuredClone(BASE_DOC)}
        draft={structuredClone(DRAFT)}
      />,
    );
    // Give the debounce window a chance to fire if it (incorrectly) would.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
