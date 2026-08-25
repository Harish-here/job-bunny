import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JobSignals } from './JobSignals';

describe('JobSignals — both populated', () => {
  it('renders reason chips and the flag block with counts', () => {
    const { container } = render(
      <JobSignals matchReasons={['A', 'B']} reviewFlags={['Stale posting']} />,
    );

    expect(container.querySelector('[data-qa="signals"]')).not.toBeNull();
    expect(screen.getByText('WHY IT MATCHES · 2')).toBeInTheDocument();
    const reasons = container.querySelector('[data-qa="match-reasons"]');
    expect(reasons).not.toBeNull();
    expect(reasons?.querySelectorAll('svg')).toHaveLength(2);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();

    expect(screen.getByText('REVIEW FLAGS · 1')).toBeInTheDocument();
    const flags = container.querySelector('[data-qa="review-flags"]');
    expect(flags).not.toBeNull();
    expect(flags?.className).toContain('border-l-2');
    expect(flags?.className).toContain('border-destructive');
    expect(flags?.className).toContain('pl-3');
    expect(screen.getByText('Stale posting')).toBeInTheDocument();
  });
});

describe('JobSignals — flags-only-empty', () => {
  it('renders reasons, omits the entire flags block', () => {
    const { container } = render(<JobSignals matchReasons={['A']} reviewFlags={[]} />);

    expect(screen.getByText('WHY IT MATCHES · 1')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="match-reasons"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="review-flags"]')).toBeNull();
    expect(screen.queryByText(/REVIEW FLAGS/)).not.toBeInTheDocument();
  });
});

describe('JobSignals — reasons-only-empty', () => {
  it('renders the no-count eyebrow + fallback line, flags render normally', () => {
    const { container } = render(
      <JobSignals matchReasons={[]} reviewFlags={['Stale posting']} />,
    );

    expect(screen.getByText('WHY IT MATCHES')).toBeInTheDocument();
    expect(screen.queryByText(/WHY IT MATCHES ·/)).not.toBeInTheDocument();
    expect(screen.getByText('No match reasons recorded.')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="match-reasons"]')).toBeNull();

    expect(screen.getByText('REVIEW FLAGS · 1')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="review-flags"]')).not.toBeNull();
  });
});

describe('JobSignals — both empty', () => {
  it('renders only the WHY IT MATCHES eyebrow + fallback line, flags block entirely omitted', () => {
    const { container } = render(<JobSignals matchReasons={[]} reviewFlags={[]} />);

    expect(container.querySelector('[data-qa="signals"]')).not.toBeNull();
    expect(screen.getByText('WHY IT MATCHES')).toBeInTheDocument();
    expect(screen.getByText('No match reasons recorded.')).toBeInTheDocument();
    expect(container.querySelector('[data-qa="match-reasons"]')).toBeNull();
    expect(container.querySelector('[data-qa="review-flags"]')).toBeNull();
    expect(screen.queryByText(/REVIEW FLAGS/)).not.toBeInTheDocument();
  });
});
