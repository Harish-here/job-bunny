import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusPip } from './StatusPip';

function iconClass(container: HTMLElement): string[] {
  const svg = container.querySelector('svg');
  return svg ? Array.from(svg.classList) : [];
}

describe('StatusPip — 5-state glyph table', () => {
  it('null -> Circle, aria-label "Not decided"', () => {
    const { container } = render(<StatusPip status={null} />);
    expect(iconClass(container)).toContain('lucide-circle');
    expect(screen.getByLabelText('Not decided')).toBeInTheDocument();
  });

  it('Lead -> Star (filled), aria-label "Lead"', () => {
    const { container } = render(<StatusPip status="Lead" />);
    expect(iconClass(container)).toContain('lucide-star');
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
    expect(screen.getByLabelText('Lead')).toBeInTheDocument();
  });

  it('Applied -> Send, aria-label "Applied"', () => {
    const { container } = render(<StatusPip status="Applied" />);
    expect(iconClass(container)).toContain('lucide-send');
    expect(screen.getByLabelText('Applied')).toBeInTheDocument();
  });

  it.each(['Recruiter Screen', 'Tech Round', 'Onsite'])(
    '%s -> ChevronsRight (primary), aria-label is the status word',
    (status) => {
      const { container } = render(<StatusPip status={status} />);
      expect(iconClass(container)).toContain('lucide-chevrons-right');
      const svg = container.querySelector('svg');
      expect(svg?.classList.contains('text-primary')).toBe(true);
      expect(svg?.classList.contains('text-success-strong')).toBe(false);
      expect(screen.getByLabelText(status)).toBeInTheDocument();
    },
  );

  it('Offer -> ChevronsRight, text-success-strong (not text-success/primary), aria-label "Offer"', () => {
    const { container } = render(<StatusPip status="Offer" />);
    expect(iconClass(container)).toContain('lucide-chevrons-right');
    const svg = container.querySelector('svg');
    expect(svg?.classList.contains('text-success-strong')).toBe(true);
    expect(svg?.classList.contains('text-primary')).toBe(false);
    expect(svg?.classList.contains('text-success')).toBe(false);
    expect(screen.getByLabelText('Offer')).toBeInTheDocument();
  });

  it.each(['Passed', 'Rejected'])(
    '%s -> Minus (destructive), aria-label is the status word',
    (status) => {
      const { container } = render(<StatusPip status={status} />);
      expect(iconClass(container)).toContain('lucide-minus');
      const svg = container.querySelector('svg');
      expect(svg?.classList.contains('text-destructive')).toBe(true);
      expect(screen.getByLabelText(status)).toBeInTheDocument();
    },
  );
});

describe('StatusPip — root data-qa', () => {
  it('always carries data-qa="job-row-pip", regardless of status', () => {
    const { container: withNull } = render(<StatusPip status={null} />);
    expect(withNull.querySelector('[data-qa="job-row-pip"]')).not.toBeNull();

    const { container: withStatus } = render(<StatusPip status="Applied" />);
    expect(withStatus.querySelector('[data-qa="job-row-pip"]')).not.toBeNull();
  });
});

describe('StatusPip — native span prop passthrough (RESOLVED GAP)', () => {
  it('forwards data-testid/title while keeping its own data-qa/aria-label', () => {
    render(<StatusPip status={null} data-testid="x" title="y" />);
    const el = screen.getByTestId('x');
    expect(el).toHaveAttribute('title', 'y');
    expect(el).toHaveAttribute('data-qa', 'job-row-pip');
    expect(el).toHaveAttribute('aria-label', 'Not decided');
  });

  it("the component's own data-qa/aria-label win over anything accidentally passed via rest", () => {
    render(
      <StatusPip
        status="Applied"
        // Intentionally conflicting values, to confirm the component's own
        // computed attributes always win over anything passed via `rest`.
        data-qa="not-mine"
        aria-label="not mine either"
      />,
    );
    const el = screen.getByLabelText('Applied');
    expect(el).toHaveAttribute('data-qa', 'job-row-pip');
  });
});
