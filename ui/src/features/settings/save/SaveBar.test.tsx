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
    render(<SaveBar isDirty successMessage={null} onSave={save} onDiscard={vi.fn()} />);
    expect(screen.getByTestId('save-bar')).toBeInTheDocument();
    expect(screen.getByTestId('discard-button')).toBeInTheDocument();
    const saveButton = screen.getByTestId('save-button');
    expect(saveButton).not.toBeDisabled();
    await userEvent.click(saveButton);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('defaults save-button to the default variant, and honors an explicit saveButtonVariant override', () => {
    const { rerender } = render(
      <SaveBar isDirty successMessage={null} onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(screen.getByTestId('save-button')).toHaveAttribute('data-variant', 'default');

    rerender(
      <SaveBar
        isDirty
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

  // B1 fix (QA settings-overhaul): `SaveBar` no longer takes `errors` at
  // all — the dirty bar renders purely off `isDirty`, regardless of
  // whether the caller's OWN validation currently fails. This proves the
  // GOV.UK finding cited in blueprint.md:481 (the button carries no
  // disabled/error gating of its own) survives that change: this wires
  // the button's `onSave` straight to a REAL `useSectionSaveState().save`
  // whose OWN `validate` always fails, and confirms the dirty bar (not a
  // validation summary) is what renders and that the click still reaches
  // `save`; `save` is then the one (task 4's job, already covered by
  // useSectionSaveState.test.tsx) that refuses to call the underlying
  // `onSave`.
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
    // the dirty bar renders (never a validation summary — SaveBar has no
    // concept of `errors` anymore) and stays mounted/enabled.
    const saveButton = screen.getByTestId('save-button');
    expect(saveButton).not.toBeDisabled();
    await userEvent.click(saveButton);
    // the click reached the hook's save() (proving SaveBar never gated it) —
    // and the hook's own validation guard then refused to call onSave.
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('SaveBar — success line', () => {
  it('renders save-success-line with the verbatim successMessage', () => {
    render(
      <SaveBar
        isDirty={false}
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
  it('renders nothing when not dirty and no success message', () => {
    const { container } = render(
      <SaveBar
        isDirty={false}
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
