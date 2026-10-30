import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../../lib/router';
import type { LinkSoftError } from '../runResult';
import { BadLinksPanel } from './BadLinksPanel';

vi.mock('../../../lib/router', () => ({ navigate: vi.fn() }));

function link(url: string, reason: string, label?: string): LinkSoftError {
  return label === undefined ? { url, reason } : { url, reason, label };
}

const TWO_LINKS: LinkSoftError[] = [
  link(
    'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
    'results list never loaded',
    'Comcast SRE',
  ),
  link(
    'https://www.linkedin.com/jobs/search-results/?keywords=platform&location=Remote',
    'results list never loaded',
    'Zafin',
  ),
];

function sixLinks(): LinkSoftError[] {
  return Array.from({ length: 6 }, (_, i) =>
    link(`https://www.linkedin.com/jobs/search/?location=Remote${i}`, 'timed out'),
  );
}

function panelList(): HTMLElement {
  const el = document.querySelector('[data-qa="run-bad-links-list"]');
  if (el === null) throw new Error('run-bad-links-list not found');
  return el as HTMLElement;
}

function fixButton(): HTMLElement {
  const el = document.querySelector('[data-qa="run-bad-links-fix"]');
  if (el === null) throw new Error('run-bad-links-fix not found');
  return el as HTMLElement;
}

function copyButton(): HTMLElement {
  const el = document.querySelector('[data-qa="run-bad-links-copy"]');
  if (el === null) throw new Error('run-bad-links-copy not found');
  return el as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BadLinksPanel — title count/pluralization', () => {
  it('renders singular for exactly 1 link', () => {
    render(<BadLinksPanel links={[link('https://x.com/a', 'timed out')]} />);
    expect(
      screen.getByText('1 search link failed — the run continued'),
    ).toBeInTheDocument();
  });

  it('renders plural for 2 links', () => {
    render(<BadLinksPanel links={TWO_LINKS} />);
    expect(
      screen.getByText('2 search links failed — the run continued'),
    ).toBeInTheDocument();
  });

  it('renders the ux-notes §4 evidence line', () => {
    render(<BadLinksPanel links={TWO_LINKS} />);
    expect(
      screen.getByText(
        'A link that worked earlier today still loaded, so LinkedIn is fine — these links are the problem.',
      ),
    ).toBeInTheDocument();
  });
});

describe('BadLinksPanel — capped list + "+N more"', () => {
  it('renders at most 5 <li> rows plus a "+1 more" trailer for a 6-item input', () => {
    render(<BadLinksPanel links={sixLinks()} />);
    const rows = within(panelList()).getAllByRole('listitem');
    // 5 link rows + 1 "+N more" trailer row.
    expect(rows).toHaveLength(6);
    expect(within(panelList()).getByText('+1 more')).toBeInTheDocument();
  });

  it('renders no "+N more" trailer when links.length <= 5', () => {
    render(<BadLinksPanel links={TWO_LINKS} />);
    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
  });

  it('B9: "+N more" is a keyboard-accessible disclosure button that reveals the rest', () => {
    render(<BadLinksPanel links={sixLinks()} />);
    const toggle = screen.getByRole('button', { name: '+1 more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(panelList()).getAllByRole('listitem')).toHaveLength(6);

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Show less');
    // All 6 links now render as their own row, plus the toggle itself.
    expect(within(panelList()).getAllByRole('listitem')).toHaveLength(7);
  });

  it('each row shows label (or shortened url), the mono shortened url with full-url title, and the reason', () => {
    render(<BadLinksPanel links={TWO_LINKS} />);
    const first = within(panelList()).getAllByRole('listitem')[0] as HTMLElement;
    expect(first).toHaveTextContent('Comcast SRE');
    expect(first).toHaveTextContent('results list never loaded');
    const urlEl = within(first).getByTitle(
      'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
    );
    expect(urlEl).toHaveTextContent('linkedin.com/jobs/…/Remote');
  });

  it('falls back to the shortened url as the label when none is given', () => {
    render(
      <BadLinksPanel
        links={[
          link('https://www.linkedin.com/jobs/search/?location=Remote', 'timed out'),
        ]}
      />,
    );
    const row = within(panelList()).getAllByRole('listitem')[0] as HTMLElement;
    expect(row).toHaveTextContent('linkedin.com/jobs/…/Remote');
  });
});

describe('BadLinksPanel — "Fix in Settings" navigates', () => {
  it('clicking calls navigate with the exact settings route object', async () => {
    render(<BadLinksPanel links={TWO_LINKS} />);
    fireEvent.click(fixButton());
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      name: 'settings',
      section: 'where-jobs-come-from',
    });
  });
});

describe('BadLinksPanel — "Copy links" clipboard + label flip', () => {
  it('writes the newline-joined full URL list to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<BadLinksPanel links={TWO_LINKS} />);
    await act(async () => {
      fireEvent.click(copyButton());
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      [
        'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
        'https://www.linkedin.com/jobs/search-results/?keywords=platform&location=Remote',
      ].join('\n'),
    );
  });

  it('flips the button label to "Copied" then back to "Copy links" after 2s', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<BadLinksPanel links={TWO_LINKS} />);
    expect(copyButton()).toHaveTextContent('Copy links');

    await act(async () => {
      fireEvent.click(copyButton());
      await Promise.resolve();
    });
    expect(copyButton()).toHaveTextContent('Copied');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(copyButton()).toHaveTextContent('Copy links');

    vi.useRealTimers();
  });

  it('swallows a clipboard denial without throwing (same idiom as DiagnosisPanel)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });

    render(<BadLinksPanel links={TWO_LINKS} />);
    await act(async () => {
      fireEvent.click(copyButton());
      await Promise.resolve();
    });
    expect(copyButton()).toHaveTextContent('Copy links');
  });
});
