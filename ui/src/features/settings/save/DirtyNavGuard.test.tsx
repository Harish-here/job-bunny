import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../../lib/router';
import { DirtyNavGuard } from './DirtyNavGuard';

vi.mock('../../../lib/router', () => ({ navigate: vi.fn() }));

const TARGET = { name: 'settings', section: 'roles-companies' } as const;

afterEach(() => {
  vi.clearAllMocks();
});

function renderGuard(props: {
  isDirty: boolean;
  save?: () => Promise<boolean>;
  discard?: () => void;
}) {
  const save = props.save ?? vi.fn().mockResolvedValue(true);
  const discard = props.discard ?? vi.fn();
  render(
    <DirtyNavGuard
      isDirty={props.isDirty}
      navigate={navigate}
      save={save}
      discard={discard}
    >
      {(go) => (
        <button type="button" data-testid="nav-link" onClick={() => go(TARGET)}>
          Filters
        </button>
      )}
    </DirtyNavGuard>,
  );
  return { save, discard };
}

describe('DirtyNavGuard — isDirty=false', () => {
  it('a wrapped navigation call passes straight through with no dialog', async () => {
    renderGuard({ isDirty: false });
    await userEvent.click(screen.getByTestId('nav-link'));
    expect(vi.mocked(navigate)).toHaveBeenCalledWith(TARGET);
    expect(screen.queryByTestId('dirty-nav-dialog')).toBeNull();
  });
});

describe('DirtyNavGuard — isDirty=true', () => {
  it('intercepts the navigation and renders dirty-nav-dialog instead of calling navigate', async () => {
    renderGuard({ isDirty: true });
    await userEvent.click(screen.getByTestId('nav-link'));
    expect(screen.getByTestId('dirty-nav-dialog')).toBeInTheDocument();
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });

  it('"Save and continue" calls save then navigate with the pending target, when save succeeds', async () => {
    const save = vi.fn().mockResolvedValue(true);
    renderGuard({ isDirty: true, save });
    await userEvent.click(screen.getByTestId('nav-link'));
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith(TARGET);
  });

  it('"Save and continue" keeps the dialog open and never navigates when save reports failure (a validation error or a failed PUT)', async () => {
    const save = vi.fn().mockResolvedValue(false);
    renderGuard({ isDirty: true, save });
    await userEvent.click(screen.getByTestId('nav-link'));
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
    expect(screen.getByTestId('dirty-nav-dialog')).toBeInTheDocument();
  });

  // Re-review finding: the dialog previously stayed open on a failed save
  // with no visible reason why — the section's own validation summary /
  // server error is still mounted, but hidden under the modal overlay.
  it('a failed "Save and continue" renders an inline error next to the dialog buttons', async () => {
    const save = vi.fn().mockResolvedValue(false);
    renderGuard({ isDirty: true, save });
    await userEvent.click(screen.getByTestId('nav-link'));
    expect(screen.queryByTestId('dirty-nav-save-error')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(screen.getByTestId('dirty-nav-save-error')).toHaveTextContent(
      "Couldn't save — fix the errors on the section first.",
    );
  });

  it('the inline save-error clears once a fresh guarded-navigate attempt reopens the dialog', async () => {
    const save = vi.fn().mockResolvedValue(false);
    renderGuard({ isDirty: true, save });
    await userEvent.click(screen.getByTestId('nav-link'));
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(screen.getByTestId('dirty-nav-save-error')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Stay here' }));
    await userEvent.click(screen.getByTestId('nav-link'));
    expect(screen.queryByTestId('dirty-nav-save-error')).toBeNull();
  });

  it('"Discard changes" calls discard then navigate with the pending target', async () => {
    const discard = vi.fn();
    renderGuard({ isDirty: true, discard });
    await userEvent.click(screen.getByTestId('nav-link'));
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(navigate)).toHaveBeenCalledWith(TARGET);
  });

  it('"Stay here" closes the dialog and never calls navigate across the whole interaction', async () => {
    renderGuard({ isDirty: true });
    await userEvent.click(screen.getByTestId('nav-link'));
    await userEvent.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(screen.queryByTestId('dirty-nav-dialog')).toBeNull();
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });

  it('a second identical nav attempt re-opens the dialog from scratch after Stay here', async () => {
    renderGuard({ isDirty: true });
    await userEvent.click(screen.getByTestId('nav-link'));
    await userEvent.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(screen.queryByTestId('dirty-nav-dialog')).toBeNull();

    await userEvent.click(screen.getByTestId('nav-link'));
    expect(screen.getByTestId('dirty-nav-dialog')).toBeInTheDocument();
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });
});
