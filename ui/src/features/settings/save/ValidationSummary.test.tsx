import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ValidationSummary } from './ValidationSummary';

describe('ValidationSummary — presence', () => {
  it('renders nothing when errors is empty', () => {
    const { container } = render(<ValidationSummary errors={{}} attempt={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pluralizes the heading: singular for one error, plural for more than one', () => {
    const { rerender } = render(<ValidationSummary errors={{ a: 'bad' }} attempt={1} />);
    expect(screen.getByTestId('validation-summary')).toHaveTextContent(
      '1 problem to fix',
    );

    rerender(<ValidationSummary errors={{ a: 'bad', b: 'also bad' }} attempt={1} />);
    expect(screen.getByTestId('validation-summary')).toHaveTextContent(
      '2 problems to fix',
    );
  });

  it('renders one <li> per error, keyed by field', () => {
    render(
      <ValidationSummary
        errors={{ 'fetching.jitterMinMs': 'bad min', 'fetching.jitterMaxMs': 'bad max' }}
        attempt={1}
      />,
    );
    expect(screen.getByTestId('validation-item-fetching.jitterMinMs')).toHaveTextContent(
      'bad min',
    );
    expect(screen.getByTestId('validation-item-fetching.jitterMaxMs')).toHaveTextContent(
      'bad max',
    );
  });
});

// B12/B13 (QA settings-overhaul, round 2): mockup S8's own
// `.validation-summary` is left-edge-only (no border on the other three
// sides), `--destructive-8` tint, 16px padding, 8px gap, and a
// `--foreground`/700 title (never destructive-coloured) — while the link
// text is `--destructive-strong` (B13's ruling), not the mockup's own
// plain `--destructive` (which the ruling found itself non-conformant,
// 4.38:1 on white).
describe('ValidationSummary — styling (B12/B13)', () => {
  it('carries the mockup S8 container classes: left-only border, destructive tint, 16px padding, 8px gap', () => {
    render(<ValidationSummary errors={{ a: 'bad' }} attempt={1} />);
    const summary = screen.getByTestId('validation-summary');
    expect(summary.className).toContain('border-0');
    expect(summary.className).toContain('border-l-2');
    expect(summary.className).toContain('border-l-destructive');
    expect(summary.className).toContain('bg-destructive/8');
    expect(summary.className).toContain('p-4');
    expect(summary.className).toContain('gap-2');
  });

  it('the title is foreground/bold, never destructive-coloured', () => {
    render(<ValidationSummary errors={{ a: 'bad' }} attempt={1} />);
    const title = screen.getByText('1 problem to fix');
    expect(title.className).toContain('text-foreground');
    expect(title.className).toContain('font-bold');
    expect(title.className).not.toContain('text-destructive');
  });

  it('the link text uses --destructive-strong (B13), not plain --destructive', () => {
    render(<ValidationSummary errors={{ a: 'bad' }} attempt={1} />);
    const link = screen.getByRole('link', { name: 'bad' });
    expect(link.className).toContain('text-destructive-strong');
  });
});

describe('ValidationSummary — link focus (B2)', () => {
  it('clicking a link focuses the REAL input carrying that exact id, not the anchor', async () => {
    render(
      <>
        <input id="fetching.jitterMinMs" aria-label="jitterMinMs" />
        <ValidationSummary
          errors={{ 'fetching.jitterMinMs': 'jitterMinMs must be <= jitterMaxMs.' }}
          attempt={1}
        />
      </>,
    );
    await userEvent.click(
      screen.getByRole('link', { name: 'jitterMinMs must be <= jitterMaxMs.' }),
    );
    expect(document.activeElement).toBe(document.getElementById('fetching.jitterMinMs'));
  });
});

describe('ValidationSummary — focus-on-attempt (B1/B2)', () => {
  it('moves focus to the summary itself when attempt increases with errors present', () => {
    const { rerender } = render(<ValidationSummary errors={{ a: 'bad' }} attempt={0} />);
    expect(document.activeElement).not.toBe(screen.queryByTestId('validation-summary'));

    rerender(<ValidationSummary errors={{ a: 'bad' }} attempt={1} />);
    expect(document.activeElement).toBe(screen.getByTestId('validation-summary'));
  });

  it('does not steal focus back merely because the live errors object changed while attempt stayed the same', () => {
    function Harness() {
      const [errors, setErrors] = useState<Record<string, string>>({ a: 'bad' });
      return (
        <>
          <input aria-label="unrelated field" />
          <button type="button" onClick={() => setErrors({ a: 'bad', b: 'also bad' })}>
            edit
          </button>
          <ValidationSummary errors={errors} attempt={1} />
        </>
      );
    }
    render(<Harness />);
    // Summary already focused once for attempt=1 above; move focus
    // elsewhere (simulating the user continuing to edit a field) and
    // confirm a later errors-only change (no new attempt) leaves it there.
    // `fireEvent` (not `userEvent`) deliberately: jsdom's own click event
    // carries no browser-native focus-follows-click behaviour, so this
    // isolates "did the COMPONENT move focus" from "did clicking a
    // <button> move focus", which is not what this test is about.
    const input = screen.getByRole('textbox', { name: 'unrelated field' });
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    expect(screen.getByTestId('validation-summary')).toHaveTextContent(
      '2 problems to fix',
    );
    expect(document.activeElement).toBe(input);
  });
});
