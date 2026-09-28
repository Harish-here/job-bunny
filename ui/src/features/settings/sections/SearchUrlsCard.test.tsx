import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchUrlsCard } from './SearchUrlsCard';
import type { RowDisplay } from './searchUrlRow.classify';
import type { SearchUrlRow as SearchUrlRowModel } from './searchUrls.model';

function makeRow(overrides: Partial<SearchUrlRowModel> = {}): SearchUrlRowModel {
  return {
    page: 'linkedin__jobs-search',
    label: 'Comcast SRE',
    url: 'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
    touched: true,
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    rows: [] as SearchUrlRowModel[],
    displayStates: [] as RowDisplay[],
    misfiledCount: 0,
    onRefile: vi.fn(),
    isRefiling: false,
    onChangeUrl: vi.fn(),
    onChangeLabel: vi.fn(),
    onBlurUrl: vi.fn(),
    onRemove: vi.fn(),
    onRemoveNow: vi.fn(),
    onAddRow: vi.fn(),
    ...overrides,
  };
}

describe('SearchUrlsCard', () => {
  it('renders one SearchUrlRow per row/display-state pair', () => {
    const rows = [
      makeRow(),
      makeRow({ label: 'Zafin Platform', page: 'linkedin__jobs-search-results' }),
    ];
    const displayStates: RowDisplay[] = [
      { kind: 'clean', page: 'linkedin__jobs-search', label: 'Comcast SRE' },
      { kind: 'clean', page: 'linkedin__jobs-search-results', label: 'Zafin Platform' },
    ];
    render(<SearchUrlsCard {...baseProps({ rows, displayStates })} />);
    expect(document.querySelector('[data-qa="search-url-row-0"]')).not.toBeNull();
    expect(document.querySelector('[data-qa="search-url-row-1"]')).not.toBeNull();
    expect(document.querySelector('[data-qa="search-url-row-2"]')).toBeNull();
  });

  it('threads index-bound callbacks from a row into the card-level handlers', () => {
    const onChangeUrl = vi.fn();
    const onRemove = vi.fn();
    const rows = [makeRow(), makeRow({ label: 'Zafin Platform' })];
    const displayStates: RowDisplay[] = [
      { kind: 'clean', page: 'linkedin__jobs-search', label: 'Comcast SRE' },
      { kind: 'clean', page: 'linkedin__jobs-search', label: 'Zafin Platform' },
    ];
    render(
      <SearchUrlsCard {...baseProps({ rows, displayStates, onChangeUrl, onRemove })} />,
    );
    const input = document.querySelector(
      '[data-qa="search-url-input-1"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://x.example/next' } });
    expect(onChangeUrl).toHaveBeenCalledWith(1, 'https://x.example/next');

    const removeButton = document.querySelector(
      '[data-qa="search-url-remove-0"]',
    ) as HTMLButtonElement;
    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('misfile notice is absent when misfiledCount is 0', () => {
    render(<SearchUrlsCard {...baseProps({ misfiledCount: 0 })} />);
    expect(document.querySelector('[data-qa="search-urls-misfile-notice"]')).toBeNull();
  });

  it('misfile notice shows plural "Re-file N links" and fires onRefile', () => {
    const onRefile = vi.fn();
    render(<SearchUrlsCard {...baseProps({ misfiledCount: 2, onRefile })} />);
    const button = screen.getByText('Re-file 2 links');
    fireEvent.click(button);
    expect(onRefile).toHaveBeenCalledTimes(1);
  });

  it('misfile notice shows singular "Re-file 1 link" when misfiledCount is 1', () => {
    render(<SearchUrlsCard {...baseProps({ misfiledCount: 1 })} />);
    expect(screen.getByText('Re-file 1 link')).toBeInTheDocument();
  });

  it('disables the refile button while isRefiling is true', () => {
    render(<SearchUrlsCard {...baseProps({ misfiledCount: 1, isRefiling: true })} />);
    expect(
      document.querySelector('[data-qa="search-urls-refile-button"]'),
    ).toBeDisabled();
  });

  it('empty-state copy appears only when rows.length === 0', () => {
    render(<SearchUrlsCard {...baseProps({ rows: [], displayStates: [] })} />);
    expect(document.querySelector('[data-qa="search-urls-empty"]')).not.toBeNull();
  });

  it('empty-state copy is absent once a row exists', () => {
    const rows = [makeRow()];
    const displayStates: RowDisplay[] = [
      { kind: 'clean', page: 'linkedin__jobs-search', label: 'Comcast SRE' },
    ];
    render(<SearchUrlsCard {...baseProps({ rows, displayStates })} />);
    expect(document.querySelector('[data-qa="search-urls-empty"]')).toBeNull();
  });

  it('"Add another search URL" button fires onAddRow', () => {
    const onAddRow = vi.fn();
    render(<SearchUrlsCard {...baseProps({ onAddRow })} />);
    fireEvent.click(screen.getByText('Add another search URL'));
    expect(onAddRow).toHaveBeenCalledTimes(1);
  });

  it('renders the card title and helper text', () => {
    render(<SearchUrlsCard {...baseProps()} />);
    expect(screen.getByText('Search URLs')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paste any LinkedIn jobs link — it's cleaned and filed automatically.",
      ),
    ).toBeInTheDocument();
  });
});
