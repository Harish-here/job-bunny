import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../runs/runs.api';
import { SaveBar } from './SaveBar';
import { useSectionSaveState } from './useSectionSaveState';

vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { Wrapper, qc };
}

async function waitForRunInFlightResolved(qc: QueryClient, profile: string) {
  await waitFor(() => {
    const state = qc.getQueryState([profile, 'runs', 'run-in-flight']);
    expect(state?.status).not.toBe('pending');
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SaveBar — dirty bar', () => {
  it('renders save-bar/discard-button/save-button; clicking save-button calls save', async () => {
    const save = vi.fn();
    render(
      <SaveBar
        isDirty
        errors={{}}
        successMessage={null}
        onSave={save}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId('save-bar')).toBeInTheDocument();
    expect(screen.getByTestId('discard-button')).toBeInTheDocument();
    const saveButton = screen.getByTestId('save-button');
    expect(saveButton).not.toBeDisabled();
    await userEvent.click(saveButton);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('defaults save-button to the default variant, and honors an explicit saveButtonVariant override', () => {
    const { rerender } = render(
      <SaveBar
        isDirty
        errors={{}}
        successMessage={null}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId('save-button')).toHaveAttribute('data-variant', 'default');

    rerender(
      <SaveBar
        isDirty
        errors={{}}
        successMessage={null}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        saveButtonVariant="outline"
      />,
    );
    expect(screen.getByTestId('save-button')).toHaveAttribute('data-variant', 'outline');
    // never disabled, regardless of variant — the de-emphasis is purely visual.
    expect(screen.getByTestId('save-button')).not.toBeDisabled();
  });

  // The dirty bar's own precondition is `isDirty && errors is empty` (a
  // previously-attempted save leaves errors, which routes to the
  // validation-summary state instead — see the "validation summary" describe
  // block below). To prove `save-button` carries no disabled/error gating of
  // its OWN — the GOV.UK finding cited in blueprint.md:481 — this wires the
  // button's `onSave` straight to a REAL `useSectionSaveState().save` whose
  // OWN `validate` always fails, so `errors` (computed fresh from
  // `currentValue`) is genuinely non-empty at click time. The click still
  // calls through to `save`; `save` is then the one (task 4's job, already
  // covered by useSectionSaveState.test.tsx) that refuses to call the
  // underlying `onSave`. This is exactly the division of responsibility the
  // brief calls out: SaveBar never itself gates the click behind `disabled`.
  function DirtyBarWiredToRealGuardedSave({
    onSave,
  }: {
    onSave: (value: { a: number }) => Promise<boolean>;
  }) {
    const state = useSectionSaveState({
      profile: 'rajni',
      initialValue: { a: 1 },
      currentValue: { a: 2 },
      validate: () => ({ 'jitter-min': 'Minimum jitter is above maximum.' }),
      onSave,
    });
    return (
      <SaveBar
        isDirty={state.isDirty}
        errors={{}}
        successMessage={state.successMessage}
        onSave={state.save}
        onDiscard={() => {}}
      />
    );
  }

  it('clicking save-button still calls through to save even while the wired save sees non-empty errors', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 1,
      offset: 0,
    });
    const onSave = vi.fn().mockResolvedValue(true);
    const { Wrapper, qc } = wrapper();
    render(<DirtyBarWiredToRealGuardedSave onSave={onSave} />, { wrapper: Wrapper });
    await waitForRunInFlightResolved(qc, 'rajni');
    const saveButton = screen.getByTestId('save-button');
    expect(saveButton).not.toBeDisabled();
    await userEvent.click(saveButton);
    // the click reached the hook's save() (proving SaveBar never gated it) —
    // and the hook's own validation guard then refused to call onSave.
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('SaveBar — validation summary', () => {
  it('renders validation-summary with one <li> per error; clicking a link focuses the offending field', async () => {
    render(
      <>
        <input id="jitter-min" aria-label="jitterMinMs" />
        <input id="jitter-max" aria-label="jitterMaxMs" />
        <SaveBar
          isDirty={false}
          errors={{
            'jitter-min': 'Minimum jitter is above maximum jitter.',
            'jitter-max': 'Maximum jitter is below minimum jitter.',
          }}
          successMessage={null}
          onSave={vi.fn()}
          onDiscard={vi.fn()}
        />
      </>,
    );
    expect(screen.getByTestId('validation-summary')).toBeInTheDocument();
    expect(screen.getByTestId('validation-item-jitter-min')).toBeInTheDocument();
    expect(screen.getByTestId('validation-item-jitter-max')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('link', { name: 'Minimum jitter is above maximum jitter.' }),
    );
    expect(document.activeElement).toBe(document.getElementById('jitter-min'));
  });

  it('takes precedence over the dirty bar when both isDirty and errors are true', () => {
    render(
      <SaveBar
        isDirty
        errors={{ foo: 'bad' }}
        successMessage={null}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId('validation-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('save-bar')).toBeNull();
  });
});

describe('SaveBar — success line', () => {
  it('renders save-success-line with the verbatim successMessage', () => {
    render(
      <SaveBar
        isDirty={false}
        errors={{}}
        successMessage="Saved. Takes effect from your next run — nothing is running right now."
        onSave={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByTestId('save-success-line')).toHaveTextContent(
      'Saved. Takes effect from your next run — nothing is running right now.',
    );
  });
});

describe('SaveBar — idle', () => {
  it('renders nothing when not dirty, no errors, no success message', () => {
    const { container } = render(
      <SaveBar
        isDirty={false}
        errors={{}}
        successMessage={null}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SaveBar — effect-asserting discard', () => {
  function Harness({ onSave }: { onSave: (value: { a: number }) => Promise<boolean> }) {
    const [currentValue, setCurrentValue] = useState({ a: 2 });
    const state = useSectionSaveState({
      profile: 'rajni',
      initialValue: { a: 1 },
      currentValue,
      validate: () => ({}),
      onSave,
    });
    return (
      <>
        <span data-testid="current-value">{JSON.stringify(currentValue)}</span>
        <SaveBar
          isDirty={state.isDirty}
          errors={state.errors}
          successMessage={state.successMessage}
          onSave={state.save}
          onDiscard={() => setCurrentValue(state.discard())}
        />
      </>
    );
  }

  it("clicking discard-button actually reverts currentValue to initialValue via the hook's own discard()", async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 1,
      offset: 0,
    });
    const onSave = vi.fn().mockResolvedValue(true);
    const { Wrapper, qc } = wrapper();
    render(<Harness onSave={onSave} />, { wrapper: Wrapper });
    await waitForRunInFlightResolved(qc, 'rajni');

    expect(screen.getByTestId('current-value')).toHaveTextContent('{"a":2}');
    await userEvent.click(screen.getByTestId('discard-button'));
    expect(screen.getByTestId('current-value')).toHaveTextContent('{"a":1}');
    // the bar itself is gone too, but that's not the load-bearing assertion —
    // the reverted value above is.
    expect(screen.queryByTestId('save-bar')).toBeNull();
  });
});
