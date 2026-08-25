import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MatchScore } from './MatchScore';

describe('MatchScore — score=74', () => {
  it('renders 74, /100, Good, exactly 3 filled bars, and the root data-qa', () => {
    const { container } = render(<MatchScore score={74} />);

    expect(container.querySelector('[data-qa="match-score"]')).not.toBeNull();
    expect(screen.getByText('74')).toBeInTheDocument();
    expect(screen.getByText('/100')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();

    const meter = container.querySelector('[data-qa="score-meter"]');
    expect(meter).not.toBeNull();
    const filled = meter?.querySelectorAll('[data-filled="true"]') ?? [];
    expect(filled).toHaveLength(3);
    const unfilled = meter?.querySelectorAll('[data-filled="false"]') ?? [];
    expect(unfilled).toHaveLength(1);
  });
});

describe('MatchScore — score=null', () => {
  it('renders an em dash, eyebrow only, no meter, never a bare 0', () => {
    const { container } = render(<MatchScore score={null} />);

    expect(container.querySelector('[data-qa="match-score"]')).not.toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('MATCH')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="score-meter"]')).toBeNull();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('/100')).not.toBeInTheDocument();
  });
});
