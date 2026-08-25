import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoardJobDetail } from '../../lib/api/types';
import { JdText } from './JdText';

const JD_WITH_TEXT: BoardJobDetail['jd'] = {
  identity: {
    id: 'gh-1',
    lane: 'greenhouse',
    url: 'https://acme.example/careers/1',
    company: 'Acme Corp',
    title: 'Senior Platform Engineer',
    scrapedAt: '2026-08-01T00:00:00.000Z',
  },
  content: { rawText: 'We are hiring a Senior Platform Engineer.' },
};

const JD_EMPTY: BoardJobDetail['jd'] = {
  identity: {
    id: 'gh-2',
    lane: 'greenhouse',
    url: 'https://acme.example/careers/2',
    company: 'Acme Corp',
    title: 'No JD Role',
    scrapedAt: '2026-08-01T00:00:00.000Z',
  },
};

describe('JdText — jd present, collapsed', () => {
  it('renders the jd card, the pre body, and a clamp with max-h-[240px]', () => {
    const { container } = render(
      <JdText
        jd={JD_WITH_TEXT}
        url="https://acme.example/careers/1"
        expanded={false}
        onToggleExpanded={() => {}}
      />,
    );

    expect(container.querySelector('[data-qa="jd"]')).not.toBeNull();
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('We are hiring a Senior Platform Engineer.');

    const clampWrap = pre?.parentElement;
    expect(clampWrap?.className).toContain('max-h-[240px]');

    const toggleButton = container.querySelector('[data-qa="jd-toggle"]');
    expect(toggleButton).not.toBeNull();
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(toggleButton?.textContent).toContain('Show full description');
  });

  it('calls onToggleExpanded when the toggle is clicked', async () => {
    const onToggleExpanded = vi.fn();
    const { container } = render(
      <JdText
        jd={JD_WITH_TEXT}
        url="https://acme.example/careers/1"
        expanded={false}
        onToggleExpanded={onToggleExpanded}
      />,
    );
    const toggleButton = container.querySelector('[data-qa="jd-toggle"]');
    await userEvent.click(toggleButton as Element);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });
});

describe('JdText — jd present, expanded', () => {
  it('drops the max-h clamp class and reads Show less', () => {
    const { container } = render(
      <JdText
        jd={JD_WITH_TEXT}
        url="https://acme.example/careers/1"
        expanded={true}
        onToggleExpanded={() => {}}
      />,
    );
    const pre = container.querySelector('pre');
    const clampWrap = pre?.parentElement;
    expect(clampWrap?.className).not.toContain('max-h-[240px]');

    const toggleButton = container.querySelector('[data-qa="jd-toggle"]');
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    expect(toggleButton?.textContent).toContain('Show less');
  });
});

describe('JdText — empty jd', () => {
  it('renders the fallback message, no toggle, and the load-bearing Open original link', () => {
    const { container } = render(
      <JdText
        jd={JD_EMPTY}
        url="https://acme.example/careers/2"
        expanded={false}
        onToggleExpanded={() => {}}
      />,
    );

    expect(screen.getByText('No description captured for this job.')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="jd-toggle"]')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();

    const openOriginal = screen.getByRole('link', { name: /Open original/ });
    expect(openOriginal).toHaveAttribute('href', 'https://acme.example/careers/2');
  });
});
