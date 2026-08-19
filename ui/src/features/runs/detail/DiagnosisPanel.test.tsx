import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosisAction } from '../diagnosisActions';
import type { DiagnosisKind, DiagnosisVerdict } from '../runDiagnosis';
import { DiagnosisPanel } from './DiagnosisPanel';

const RUN_AGAIN = (): DiagnosisAction => ({ kind: 'run', label: 'Run again' });
const SHOW_FULL_LOG = (): DiagnosisAction => ({
  kind: 'reveal',
  label: 'Show full log',
  target: 'events',
});

/** One fixture per `DiagnosisKind` the registry actually produces, mirroring
 * the real shape `classifyFailure` returns (`title`/`action`/optional
 * `secondaryAction`, plus `rawError`/`lastCheckpoint` for `fallback` only).
 * `retryAt` is deliberately omitted here — the breaker-open effect tests
 * below build their own verdict with a fresh, test-local timestamp instead
 * of baking one into a shared fixture. */
function verdictFor(kind: Exclude<DiagnosisKind, 'fallback'>): DiagnosisVerdict {
  const byKind: Record<Exclude<DiagnosisKind, 'fallback'>, DiagnosisVerdict> = {
    stall: {
      kind: 'stall',
      title: 'The `structure` stage stopped reporting progress for 12 minute(s).',
      action: RUN_AGAIN(),
      secondaryAction: SHOW_FULL_LOG(),
    },
    'total-outage': {
      kind: 'total-outage',
      title:
        'Every attempted lane in the `source` stage failed this run — this looks like an expired login or a broader outage.',
      action: RUN_AGAIN(),
      secondaryAction: SHOW_FULL_LOG(),
    },
    'expired-login': {
      kind: 'expired-login',
      title: 'LinkedIn login has expired.',
      action: RUN_AGAIN(),
      secondaryAction: SHOW_FULL_LOG(),
    },
    'zero-yield-healthy': {
      kind: 'zero-yield-healthy',
      title:
        'Ran clean — no jobs made it through your filter. Biggest drop: `filter` — 189 by `locations`.',
      action: {
        kind: 'navigate',
        label: 'Review filter rules →',
        route: { name: 'settings', section: 'roles-companies' },
      },
    },
    'breaker-open': {
      kind: 'breaker-open',
      title: 'LinkedIn is soft-blocking us — the throttle breaker is open.',
      action: { kind: 'run', label: 'Run again', disabled: true },
      secondaryAction: SHOW_FULL_LOG(),
    },
    'chrome-not-found': {
      kind: 'chrome-not-found',
      title: "Chrome wasn't found at any known path.",
      action: {
        kind: 'copy',
        label: 'Copy: jobbunny doctor --profile rajni',
        command: 'jobbunny doctor --profile rajni',
      },
      secondaryAction: SHOW_FULL_LOG(),
    },
    degraded: {
      kind: 'degraded',
      title: 'Ran with warnings — 5 soft errors logged this run.',
      action: { kind: 'reveal', label: 'Review run events', target: 'events' },
    },
  };
  return byKind[kind];
}

const FALLBACK_VERDICT: DiagnosisVerdict = {
  kind: 'fallback',
  title: 'Failed at `structure`',
  action: RUN_AGAIN(),
  secondaryAction: SHOW_FULL_LOG(),
  rawError:
    "TypeError: Cannot read properties of undefined (reading 'foo')\n  at bar.ts:12",
  lastCheckpoint: 'structure/09-14',
};

function noop() {}

/** "Primary action" in this codebase's idiom (DiagnosisPanel.tsx doc
 * comment): a shadcn `Button` with `variant="default"`, which renders
 * `data-variant="default"` on the DOM element (`button.tsx`). */
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

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

// Restated per the mockup-drift fix: the mockup pairs a primary button with
// a quiet secondary link on every non-calm failure state, which the
// blueprint's original "exactly one primary button, full stop" rule
// contradicted. The correct invariant is exactly one PRIMARY control, plus
// AT MOST one QUIET secondary — never zero primaries (except the calm
// zero-yield-healthy exception below) and never two primaries.
describe('DiagnosisPanel — exactly one primary action, at most one quiet secondary', () => {
  for (const kind of NON_CALM_KINDS) {
    it(`renders exactly one primary action for '${kind}', text matching verdict.action.label`, () => {
      const verdict = verdictFor(kind);
      render(<DiagnosisPanel verdict={verdict} onRun={noop} onReveal={noop} />);
      expect(primaryButtons()).toHaveLength(1);
      const primary = screen.getByTestId('diagnosis-action');
      expect(primary).toHaveTextContent(verdict.action.label);

      const secondaryCount = screen.queryAllByTestId('diagnosis-secondary-action').length;
      expect(secondaryCount).toBeLessThanOrEqual(1);
      if (verdict.secondaryAction) {
        expect(screen.getByTestId('diagnosis-secondary-action')).toHaveTextContent(
          verdict.secondaryAction.label,
        );
      }
    });
  }

  it("renders exactly one primary action for 'fallback'", () => {
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} onRun={noop} onReveal={noop} />);
    expect(primaryButtons()).toHaveLength(1);
    expect(screen.getByTestId('diagnosis-action')).toHaveTextContent('Run again');
    expect(screen.getByTestId('diagnosis-secondary-action')).toHaveTextContent(
      'Show full log',
    );
  });
});

describe("DiagnosisPanel — 'zero-yield-healthy' calm treatment (AC10, C8)", () => {
  it('renders ZERO primary-action buttons', () => {
    render(
      <DiagnosisPanel
        verdict={verdictFor('zero-yield-healthy')}
        onRun={noop}
        onReveal={noop}
      />,
    );
    expect(primaryButtons()).toHaveLength(0);
  });

  it('renders a quiet single action instead ("Review filter rules")', () => {
    render(
      <DiagnosisPanel
        verdict={verdictFor('zero-yield-healthy')}
        onRun={noop}
        onReveal={noop}
      />,
    );
    const link = screen.getByRole('button', { name: /review filter rules/i });
    expect(link.getAttribute('data-variant')).not.toBe('default');
    // Calm kind: no secondary either — it's the panel's ONLY control.
    expect(screen.queryByTestId('diagnosis-secondary-action')).not.toBeInTheDocument();
  });
});

describe('DiagnosisPanel — line 1 / line 2 anatomy', () => {
  it('renders line 1 as the verdict title, for every kind', () => {
    for (const kind of [...NON_CALM_KINDS, 'zero-yield-healthy' as const]) {
      const { unmount } = render(
        <DiagnosisPanel verdict={verdictFor(kind)} onRun={noop} onReveal={noop} />,
      );
      expect(screen.getByTestId('diagnosis-line-1')).toHaveTextContent(
        verdictFor(kind).title,
      );
      unmount();
    }
  });

  it('renders a non-empty line 2 evidence clause distinct from line 1, for every non-fallback kind', () => {
    for (const kind of [...NON_CALM_KINDS, 'zero-yield-healthy' as const]) {
      const { unmount } = render(
        <DiagnosisPanel verdict={verdictFor(kind)} onRun={noop} onReveal={noop} />,
      );
      const line2 = screen.getByTestId('diagnosis-line-2');
      expect(line2.textContent).toBeTruthy();
      expect(line2.textContent).not.toBe(verdictFor(kind).title);
      unmount();
    }
  });
});

describe('DiagnosisPanel — fallback verdict (AC11)', () => {
  it('renders the raw error inside a 2-line-clamped, expandable element', () => {
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} onRun={noop} onReveal={noop} />);
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
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} onRun={noop} onReveal={noop} />);
    expect(screen.getByTestId('diagnosis-last-checkpoint')).toHaveTextContent(
      'structure/09-14',
    );
  });

  it('renders no line-2 evidence-clause element (the raw error replaces it)', () => {
    render(<DiagnosisPanel verdict={FALLBACK_VERDICT} onRun={noop} onReveal={noop} />);
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
    const { container } = render(
      <DiagnosisPanel verdict={verdictFor('degraded')} onRun={noop} onReveal={noop} />,
    );
    const iconWrapper = container.querySelector('.rounded-full');
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.className).toContain('bg-amber');
    expect(iconWrapper?.className).not.toContain('bg-destructive');
  });

  it('never renders the generic "Failed at `...`" fallback copy', () => {
    render(
      <DiagnosisPanel verdict={verdictFor('degraded')} onRun={noop} onReveal={noop} />,
    );
    expect(screen.queryByText(/^Failed at/)).toBeNull();
    expect(screen.getByTestId('diagnosis-line-1')).toHaveTextContent(
      /ran with warnings/i,
    );
  });
});

// ---- effect tests: every action.kind dispatches to a real handler --------

describe('DiagnosisPanel — action effects, one per action.kind', () => {
  it("kind: 'run' — clicking the primary calls onRun", async () => {
    const onRun = vi.fn();
    render(
      <DiagnosisPanel verdict={verdictFor('stall')} onRun={onRun} onReveal={noop} />,
    );
    await userEvent.click(screen.getByTestId('diagnosis-action'));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("kind: 'navigate' — clicking 'zero-yield-healthy's action navigates to #/settings/roles-companies", async () => {
    render(
      <DiagnosisPanel
        verdict={verdictFor('zero-yield-healthy')}
        onRun={noop}
        onReveal={noop}
      />,
    );
    await userEvent.click(screen.getByTestId('diagnosis-action'));
    expect(window.location.hash).toBe('#/settings/roles-companies');
  });

  it("kind: 'copy' — clicking chrome-not-found's action writes the exact doctor command to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <DiagnosisPanel
        verdict={verdictFor('chrome-not-found')}
        onRun={noop}
        onReveal={noop}
      />,
    );
    await userEvent.click(screen.getByTestId('diagnosis-action'));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('jobbunny doctor --profile rajni');
  });

  it("kind: 'reveal' (primary) — clicking degraded's 'Review run events' calls onReveal", async () => {
    const onReveal = vi.fn();
    render(
      <DiagnosisPanel
        verdict={verdictFor('degraded')}
        onRun={noop}
        onReveal={onReveal}
      />,
    );
    await userEvent.click(screen.getByTestId('diagnosis-action'));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("kind: 'reveal' (secondary) — clicking the quiet 'Show full log' secondary also calls onReveal", async () => {
    const onReveal = vi.fn();
    render(
      <DiagnosisPanel verdict={verdictFor('stall')} onRun={noop} onReveal={onReveal} />,
    );
    await userEvent.click(screen.getByTestId('diagnosis-secondary-action'));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});

describe('DiagnosisPanel — breaker-open: disabled primary + countdown chip', () => {
  it('the primary is disabled and clicking it never calls onRun', async () => {
    const onRun = vi.fn();
    render(
      <DiagnosisPanel
        verdict={verdictFor('breaker-open')}
        onRun={onRun}
        onReveal={noop}
      />,
    );
    const primary = screen.getByTestId('diagnosis-action');
    expect(primary).toBeDisabled();
    await userEvent.click(primary);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('renders "Retry in <N>m" for a future retryAt', () => {
    const retryAt = new Date(Date.now() + 34 * 60_000).toISOString();
    const verdict: DiagnosisVerdict = {
      ...verdictFor('breaker-open'),
      action: { kind: 'run', label: 'Run again', disabled: true, retryAt },
    };
    render(<DiagnosisPanel verdict={verdict} onRun={noop} onReveal={noop} />);
    expect(screen.getByTestId('diagnosis-retry-chip')).toHaveTextContent(/Retry in \d+m/);
  });

  it('renders NO chip when retryAt is absent', () => {
    render(
      <DiagnosisPanel
        verdict={verdictFor('breaker-open')}
        onRun={noop}
        onReveal={noop}
      />,
    );
    expect(screen.queryByTestId('diagnosis-retry-chip')).not.toBeInTheDocument();
  });

  it('renders NO chip when retryAt is already in the past', () => {
    const retryAt = new Date(Date.now() - 60_000).toISOString();
    const verdict: DiagnosisVerdict = {
      ...verdictFor('breaker-open'),
      action: { kind: 'run', label: 'Run again', disabled: true, retryAt },
    };
    render(<DiagnosisPanel verdict={verdict} onRun={noop} onReveal={noop} />);
    expect(screen.queryByTestId('diagnosis-retry-chip')).not.toBeInTheDocument();
  });
});
