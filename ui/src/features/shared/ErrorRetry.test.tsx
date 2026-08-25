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

  it('renders no data-qa attribute when qa is omitted, and the given one when passed', () => {
    const { container: bare } = render(<ErrorRetry message="oops" onRetry={() => {}} />);
    expect(bare.querySelector('[data-qa]')).toBeNull();

    const { container: tagged } = render(
      <ErrorRetry message="oops" onRetry={() => {}} qa="list-error" />,
    );
    expect(tagged.querySelector('[data-qa="list-error"]')).not.toBeNull();
  });
});
