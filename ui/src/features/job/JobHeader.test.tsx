import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BoardJobRow } from '../../lib/api/types';
import { JobHeader } from './JobHeader';

function makeRow(over: Partial<BoardJobRow> = {}): BoardJobRow {
  return {
    id: 'gh-1',
    lane: 'greenhouse',
    title: 'Senior Platform Engineer',
    company: 'Acme Corp',
    url: 'https://acme.example/careers/1',
    seniority: 'Senior',
    locationCity: 'Bengaluru',
    workType: 'remote',
    timezone: 'IST',
    skills: [],
    excitement: null,
    score: 74,
    matchReasons: [],
    reviewFlags: [],
    dateFound: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    archived: false,
    tracking: null,
    ...over,
  };
}

describe('JobHeader — not archived', () => {
  it('renders verdict-header, title, MatchScore, and the provenance line', () => {
    const { container } = render(<JobHeader job={makeRow()} />);

    expect(container.querySelector('[data-qa="verdict-header"]')).not.toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Senior Platform Engineer' }),
    ).toBeInTheDocument();

    const matchScore = container.querySelector('[data-qa="match-score"]');
    expect(matchScore).not.toBeNull();
    expect(matchScore?.textContent).toContain('74');
    expect(matchScore?.textContent).toContain('/100');

    const provenance = container.querySelector('[data-qa="provenance-line"]');
    expect(provenance).not.toBeNull();

    const companyLink = screen.getByRole('link', { name: /Acme Corp/ });
    expect(companyLink).toHaveAttribute('href', 'https://acme.example/careers/1');

    const laneLabel = container.querySelector('[data-qa="lane-label"]');
    expect(laneLabel).not.toBeNull();
    expect(laneLabel?.textContent).toContain('Greenhouse');
    expect(laneLabel?.textContent).not.toContain('greenhouse');

    expect(container.querySelector('[data-qa="archived-strip"]')).toBeNull();
  });

  it('2-line-clamps the title', () => {
    const { container } = render(<JobHeader job={makeRow()} />);
    const heading = container.querySelector('h1');
    expect(heading?.className).toContain('line-clamp-2');
  });
});

describe('JobHeader — archived', () => {
  it('composes ArchivedStrip', () => {
    const { container } = render(<JobHeader job={makeRow({ archived: true })} />);
    expect(container.querySelector('[data-qa="archived-strip"]')).not.toBeNull();
  });

  // QA round 1 bug 7: blueprint §3 orders the pane "ArchivedStrip
  // (conditional) → JobHeader (verdict-header…)" — archived-strip must
  // precede verdict-header in document order, as a sibling, not a child.
  it('renders archived-strip BEFORE verdict-header, as a sibling', () => {
    const { container } = render(<JobHeader job={makeRow({ archived: true })} />);
    const strip = container.querySelector('[data-qa="archived-strip"]');
    const header = container.querySelector('[data-qa="verdict-header"]');
    expect(strip).not.toBeNull();
    expect(header).not.toBeNull();
    expect(strip?.compareDocumentPosition(header as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(header?.contains(strip)).toBe(false);
  });
});

describe('JobHeader — lane label for every lane resolves to Building2, never raw', () => {
  it('renders a non-raw label for the linkedin lane too', () => {
    const { container } = render(<JobHeader job={makeRow({ lane: 'linkedin' })} />);
    const laneLabel = container.querySelector('[data-qa="lane-label"]');
    expect(laneLabel?.textContent).toContain('LinkedIn');
    expect(laneLabel?.querySelector('svg')).not.toBeNull();
  });
});
