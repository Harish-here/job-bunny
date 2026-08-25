import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorRetry } from './ErrorRetry';

describe('ErrorRetry', () => {
  it('renders the message and fires onRetry on click', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorRetry message="Something broke" onRetry={onRetry} />);

    expect(screen.getByText('Something broke')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
