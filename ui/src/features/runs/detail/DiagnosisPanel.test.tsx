import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DiagnosisKind, DiagnosisVerdict } from '../runDiagnosis';
import { DiagnosisPanel } from './DiagnosisPanel';

/** One fixture per `DiagnosisKind` B14 actually produces, mirroring the
 * shape `classifyFailure` returns (title/nextAction always present, plus
 * rawError/lastCheckpoint for `fallback` only). */
function verdictFor(kind: Exclude<DiagnosisKind, 'fallback'>): DiagnosisVerdict {
  const byKind: Record<Exclude<DiagnosisKind, 'fallback'>, DiagnosisVerdict> = {
    stall: {
      kind: 'stall',
      title: 'The `structure` stage stopped reporting progress for 12 minute(s).',
      nextAction: 'Run again',
    },
    'total-outage': {
      kind: 'total-outage',
      title:
        'Every attempted lane in the `source` stage failed this run — this looks like an expired login or a broader outage.',
      nextAction: 'Run again',
    },
    'expired-login': {
      kind: 'expired-login',
      title: 'LinkedIn login has expired.',
      nextAction: 'Run again',
    },
    'zero-yield-healthy': {
      kind: 'zero-yield-healthy',
      title:
        'Ran clean — no jobs made it through your filter. Biggest drop: `filter` — 189 by `locations`.',
      nextAction: 'Review filter rules',
    },
    'breaker-open': {
      kind: 'breaker-open',
      title: 'LinkedIn is soft-blocking us — the throttle breaker is open.',
      nextAction: 'Run again once the throttle breaker reopens',
    },
    'chrome-not-found': {
      kind: 'chrome-not-found',
      title: "Chrome wasn't found at any known path.",
      nextAction: 'Run `jobbunny doctor`',
    },
    degraded: {
      kind: 'degraded',
      title: 'Ran with warnings — 5 soft errors logged this run.',
      nextAction: 'Review run events',
    },
  };
  return byKind[kind];
}

const FALLBACK_VERDICT: DiagnosisVerdict = {
  kind: 'fallback',
  title: 'Failed at `structure`',
  nextAction: 'Run again',
  rawError:
    "TypeError: Cannot read properties of undefined (reading 'foo')\n  at bar.ts:12",
  lastCheckpoint: 'structure/09-14',
};

/** "Primary action" in this codebase's idiom (DiagnosisPanel.tsx doc
 * comment): a shadcn `Button` with `variant="default"`, which renders
 * `data-variant="default"` on the DOM element (`button.tsx`). Every other
 * button rendered by this panel (the plain fallback-expander `<button>`, or
 * a `variant="link"` secondary) carries no `data-variant="default"`. */
function primaryButtons(): HTMLElement[] {
  return screen
    .getAllByRole('button')
    .filter((el) => el.getAttribute('data-variant') === 'default');
}

const NON_CALM_KINDS: Exclude<DiagnosisKind, 'fallback' | 'zero-yield-healthy'>[] = [
  'stall',
  'total-outage',
  'expired-login',
  'breaker-open',
  'chrome-not-found',
  'degraded',
];

describe('DiagnosisPanel — exactly one primary action per non-calm verdict', () => {
  for (const kind of NON_CALM_KINDS) {
    it(`renders exactly one primary-action button for '${kind}'`, () => {
      const verdict = verdictFor(kind);
      render(<DiagnosisPanel verdict={verdict} />);
      expect(primaryButtons()).toHaveLength(1);
      expect(primaryButtons()[0]).toHaveTextContent(verdict.nextAction);
    });
  }

  it("renders exactly one primary-action button for 'fallback'", () => {
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} />);
    expect(primaryButtons()).toHaveLength(1);
    expect(primaryButtons()[0]).toHaveTextContent('Run again');
  });
});

describe("DiagnosisPanel — 'zero-yield-healthy' calm treatment (AC10, C8)", () => {
  it('renders ZERO primary-action buttons', () => {
    render(<DiagnosisPanel verdict={verdictFor('zero-yield-healthy')} />);
    expect(primaryButtons()).toHaveLength(0);
  });

  it('renders a quiet secondary link instead ("Review filter rules")', () => {
    render(<DiagnosisPanel verdict={verdictFor('zero-yield-healthy')} />);
    const link = screen.getByRole('button', { name: /review filter rules/i });
    expect(link.getAttribute('data-variant')).not.toBe('default');
  });
});

describe('DiagnosisPanel — line 1 / line 2 anatomy', () => {
  it('renders line 1 as the verdict title, for every kind', () => {
    for (const kind of [...NON_CALM_KINDS, 'zero-yield-healthy' as const]) {
      const { unmount } = render(<DiagnosisPanel verdict={verdictFor(kind)} />);
      expect(screen.getByTestId('diagnosis-line-1')).toHaveTextContent(
        verdictFor(kind).title,
      );
      unmount();
    }
  });

  it('renders a non-empty line 2 evidence clause distinct from line 1, for every non-fallback kind', () => {
    for (const kind of [...NON_CALM_KINDS, 'zero-yield-healthy' as const]) {
      const { unmount } = render(<DiagnosisPanel verdict={verdictFor(kind)} />);
      const line2 = screen.getByTestId('diagnosis-line-2');
      expect(line2.textContent).toBeTruthy();
      expect(line2.textContent).not.toBe(verdictFor(kind).title);
      unmount();
    }
  });
});

describe('DiagnosisPanel — fallback verdict (AC11)', () => {
  it('renders the raw error inside a 2-line-clamped, expandable element', () => {
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} />);
    const pre = screen.getByTestId('diagnosis-raw-error');
    expect(pre).toHaveTextContent('TypeError: Cannot read properties of undefined');
    expect(pre.className).toContain('line-clamp-2');

    const toggle = screen.getByTestId('diagnosis-raw-error-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('diagnosis-raw-error').className).not.toContain(
      'line-clamp-2',
    );
  });

  it('shows the last checkpoint', () => {
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} />);
    expect(screen.getByTestId('diagnosis-last-checkpoint')).toHaveTextContent(
      'structure/09-14',
    );
  });

  it('renders no line-2 evidence-clause element (the raw error replaces it)', () => {
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} />);
    expect(screen.queryByTestId('diagnosis-line-2')).toBeNull();
  });
});

// Fix-round finding #2: a 'degraded' run is `status: 'passed'` — it must
// never read as a whole-run failure. Asserts the tint is amber (the same
// register `stall`/`expired-login`/`breaker-open` already get), NEVER the
// destructive-red `total-outage`/`chrome-not-found`/`fallback` share, and
// that neither line renders the fallback verdict's "Failed at `...`" copy.
describe("DiagnosisPanel — 'degraded' never reads as a whole-run failure (fix-round finding #2)", () => {
  it('tints the icon amber, never destructive-red', () => {
    const { container } = render(<DiagnosisPanel verdict={verdictFor('degraded')} />);
    const iconWrapper = container.querySelector('.rounded-full');
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.className).toContain('bg-amber');
    expect(iconWrapper?.className).not.toContain('bg-destructive');
  });

  it('never renders the generic "Failed at `...`" fallback copy', () => {
    render(<DiagnosisPanel verdict={verdictFor('degraded')} />);
    expect(screen.queryByText(/^Failed at/)).toBeNull();
    expect(screen.getByTestId('diagnosis-line-1')).toHaveTextContent(
      /ran with warnings/i,
    );
  });

  it('renders exactly one primary action, distinct evidence line 2', () => {
    render(<DiagnosisPanel verdict={verdictFor('degraded')} />);
    expect(primaryButtons()).toHaveLength(1);
    const line2 = screen.getByTestId('diagnosis-line-2');
    expect(line2.textContent).toBeTruthy();
    expect(line2.textContent).not.toBe(verdictFor('degraded').title);
  });
});
