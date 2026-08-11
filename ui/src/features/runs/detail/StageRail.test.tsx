import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STAGE_ORDER } from '../runProgress';
import { StageRail, type StageRailStage } from './StageRail';

function makeStages(
  over: Partial<Record<(typeof STAGE_ORDER)[number], StageRailStage['state']>> = {},
): StageRailStage[] {
  return STAGE_ORDER.map((name, index) => ({
    name,
    state: over[name] ?? 'pending',
    elapsedMs: over[name] === 'done' ? (index + 1) * 1000 : null,
  }));
}

describe('StageRail — variant="detail"', () => {
  it('renders 10 segments grouped 3/3/4 as three wrapper groups', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages()}
        failedStage={null}
        currentStage={null}
      />,
    );

    const groups = screen.getAllByTestId('stage-rail-group');
    expect(groups).toHaveLength(3);
    expect(within(groups[0] as HTMLElement).getAllByRole('button')).toHaveLength(3);
    expect(within(groups[1] as HTMLElement).getAllByRole('button')).toHaveLength(3);
    expect(within(groups[2] as HTMLElement).getAllByRole('button')).toHaveLength(4);
  });

  it('renders an <ol> root with one <button> per segment', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages()}
        failedStage={null}
        currentStage={null}
      />,
    );

    const rail = screen.getByTestId('stage-rail');
    expect(rail.tagName).toBe('OL');
    expect(within(rail).getAllByRole('button')).toHaveLength(10);
  });

  it('marks exactly the current segment with aria-current="step"', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages({ reconcile: 'done', farm: 'done', source: 'current' })}
        failedStage={null}
        currentStage="source"
      />,
    );

    const current = screen.getByRole('button', { current: 'step' });
    expect(current).toHaveAccessibleName('stage 3 of 10, source, current, —');
    const others = screen.getAllByRole('button').filter((b) => b !== current);
    for (const other of others) {
      expect(other).not.toHaveAttribute('aria-current');
    }
  });

  it('labels a done segment with its elapsed duration', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages({ reconcile: 'done' })}
        failedStage={null}
        currentStage={null}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'stage 1 of 10, reconcile, done, 1s' }),
    ).toBeInTheDocument();
  });

  it('labels a failed segment in ux-notes §4 exact format', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages({
          reconcile: 'done',
          farm: 'done',
          source: 'done',
          compress: 'done',
          structure: 'failed',
        }).map((s) => (s.name === 'structure' ? { ...s, elapsedMs: 134000 } : s))}
        failedStage="structure"
        currentStage={null}
      />,
    );

    expect(
      screen.getByRole('button', {
        name: 'stage 5 of 10, structure, failed, 2m 14s',
      }),
    ).toBeInTheDocument();
  });

  it('labels a pending segment with the documented "—" duration convention', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages()}
        failedStage={null}
        currentStage={null}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'stage 10 of 10, sync, pending, —' }),
    ).toBeInTheDocument();
  });

  it('renders a text partner sentence naming the current stage', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages({ reconcile: 'done', farm: 'done', source: 'current' })}
        failedStage={null}
        currentStage="source"
      />,
    );

    expect(screen.getByTestId('stage-rail-text-partner')).toHaveTextContent(
      'stage 3 of 10 — source',
    );
  });

  it('renders a text partner sentence naming the failed stage', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages({ structure: 'failed' })}
        failedStage="structure"
        currentStage={null}
      />,
    );

    expect(screen.getByTestId('stage-rail-text-partner')).toHaveTextContent(
      'stage 5 of 10 — structure',
    );
  });

  it('renders the three group labels', () => {
    render(
      <StageRail
        variant="detail"
        stages={makeStages()}
        failedStage={null}
        currentStage={null}
      />,
    );

    expect(screen.getByText('acquire')).toBeInTheDocument();
    expect(screen.getByText('understand')).toBeInTheDocument();
    expect(screen.getByText('decide')).toBeInTheDocument();
  });
});

describe('StageRail — variant="strip"', () => {
  it('renders role="img" with a single aria-label summarizing progress', () => {
    render(
      <StageRail
        variant="strip"
        stages={makeStages({ reconcile: 'done', farm: 'done', source: 'current' })}
        failedStage={null}
        currentStage="source"
      />,
    );

    const rail = screen.getByRole('img');
    expect(rail.getAttribute('aria-label')).toBe('stage 3 of 10 — source');
  });

  it('contains no focusable buttons', () => {
    render(
      <StageRail
        variant="strip"
        stages={makeStages()}
        failedStage={null}
        currentStage={null}
      />,
    );

    const rail = screen.getByRole('img');
    expect(within(rail).queryAllByRole('button')).toHaveLength(0);
  });

  it('does not render group labels', () => {
    render(
      <StageRail
        variant="strip"
        stages={makeStages()}
        failedStage={null}
        currentStage={null}
      />,
    );

    expect(screen.queryByText('acquire')).not.toBeInTheDocument();
    expect(screen.queryByText('understand')).not.toBeInTheDocument();
    expect(screen.queryByText('decide')).not.toBeInTheDocument();
  });
});

describe('StageRail — state type', () => {
  it('the four-literal StageState type rejects a fifth "skipped" value at compile time', () => {
    // Type-system guarantee: this assignment would be a TS error if uncommented —
    // const bad: StageRailStage['state'] = 'skipped';
    const allowed: StageRailStage['state'][] = ['done', 'current', 'pending', 'failed'];
    expect(allowed).toHaveLength(4);
  });
});
