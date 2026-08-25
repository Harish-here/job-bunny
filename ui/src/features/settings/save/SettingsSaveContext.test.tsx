import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsSaveProvider,
  useRegisterSettingsSave,
  useSettingsSaveGuardState,
} from './SettingsSaveContext';

function GuardProbe() {
  const { isDirty, save, discard } = useSettingsSaveGuardState();
  return (
    <div>
      <span data-testid="guard-isDirty">{String(isDirty)}</span>
      <button type="button" onClick={() => void save()}>
        guard-save
      </button>
      <button type="button" onClick={discard}>
        guard-discard
      </button>
    </div>
  );
}

function FakeSection({
  save,
  discard,
}: {
  save: () => Promise<boolean>;
  discard: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  useRegisterSettingsSave({ isDirty: dirty, save, discard });
  return (
    <button type="button" data-testid="section-make-dirty" onClick={() => setDirty(true)}>
      make dirty
    </button>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSettingsSaveGuardState — no provider (default context)', () => {
  it('is inert: isDirty false, save resolves true, discard is a no-op', async () => {
    render(<GuardProbe />);
    expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('false');
    await userEvent.click(screen.getByText('guard-save'));
    await userEvent.click(screen.getByText('guard-discard'));
  });
});

describe('SettingsSaveProvider — registration', () => {
  it('a registered section flips the guard state isDirty as its own isDirty changes', async () => {
    render(
      <SettingsSaveProvider>
        <GuardProbe />
        <FakeSection save={vi.fn().mockResolvedValue(true)} discard={vi.fn()} />
      </SettingsSaveProvider>,
    );
    expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('false');
    await userEvent.click(screen.getByTestId('section-make-dirty'));
    expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('true');
  });

  it("the guard's save/discard delegate to the CURRENTLY registered section's own save/discard", async () => {
    const save = vi.fn().mockResolvedValue(true);
    const discard = vi.fn();
    render(
      <SettingsSaveProvider>
        <GuardProbe />
        <FakeSection save={save} discard={discard} />
      </SettingsSaveProvider>,
    );
    await userEvent.click(screen.getByText('guard-save'));
    expect(save).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText('guard-discard'));
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('unregistering (unmount) resets isDirty back to false — no leaking dirty flag across a section swap', async () => {
    function Wrapper() {
      const [mounted, setMounted] = useState(true);
      return (
        <SettingsSaveProvider>
          <GuardProbe />
          {mounted && (
            <FakeSection save={vi.fn().mockResolvedValue(true)} discard={vi.fn()} />
          )}
          <button type="button" data-testid="unmount" onClick={() => setMounted(false)}>
            unmount
          </button>
        </SettingsSaveProvider>
      );
    }
    render(<Wrapper />);
    await userEvent.click(screen.getByTestId('section-make-dirty'));
    expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('true');
    await userEvent.click(screen.getByTestId('unmount'));
    expect(screen.getByTestId('guard-isDirty')).toHaveTextContent('false');
  });
});
