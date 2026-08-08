import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WizardStepProps } from '../wizard/wizard.types';
import { HubStepDialog } from './HubStepDialog';
import { hubKeys } from './hub.queries';

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

// Step3About is faked ONLY to make registration timing controllable for the
// "Save disabled until registered" assertion below — every real wizard step
// registers its submit handler synchronously, unconditionally, on its own
// mount (the frozen contract), so there is no observable window in which a
// REAL step's Save button is disabled after render() returns. Step4Hunt and
// Step5Extras are exercised as the REAL, unmocked components in every other
// test in this file. This mock lives in a TEST file and never touches
// anything under ui/src/features/wizard/.
vi.mock('../wizard/steps/Step3About', () => ({
  Step3About: ({ registerSubmit }: WizardStepProps) => (
    <button
      type="button"
      data-testid="fake-register"
      onClick={() => registerSubmit(async () => true)}
    >
      Register
    </button>
  ),
}));

function renderDialog(
  cardId: 'persona-filters' | 'search-urls' | 'integrations',
  onClose: () => void = vi.fn(),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const result = render(
    <HubStepDialog profile="rajni" cardId={cardId} onClose={onClose} />,
    { wrapper },
  );
  return { ...result, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HubStepDialog', () => {
  it('renders the hub-panel with the matching data-card-id', () => {
    renderDialog('persona-filters');
    expect(screen.getByTestId('hub-panel')).toHaveAttribute(
      'data-card-id',
      'persona-filters',
    );
  });

  it('disables Save until the hosted step registers a handler', async () => {
    renderDialog('persona-filters');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByTestId('fake-register'));
    expect(save).not.toBeDisabled();
  });

  it('a handler resolving false leaves the dialog open', async () => {
    const onClose = vi.fn();
    renderDialog('integrations', onClose);

    await userEvent.type(screen.getByLabelText('Telegram chat ID'), 'not-a-number');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // No extra waitFor: Step5Extras' own handleSubmit wraps its field-error
    // setState in flushSync (the phase-3 timing pattern, added there for
    // exactly this reason — handleSubmit is invoked imperatively, outside
    // any React-controlled event), so the committed DOM is already visible
    // the instant this awaited click resolves.
    expect(screen.getByText('A Telegram chat ID is a whole number.')).toBeInTheDocument();
    expect(screen.getByTestId('hub-panel')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a handler resolving true closes the dialog and invalidates the doctor query', async () => {
    const onClose = vi.fn();
    const { qc } = renderDialog('integrations', onClose);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    // Every field left empty: Step5Extras' handleSubmit validates to zero
    // errors and, with every trimmed input empty, performs zero network
    // calls before resolving true — no fetch stub is needed anywhere in
    // this file.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: hubKeys.doctor('rajni') }),
    );
  });
});
