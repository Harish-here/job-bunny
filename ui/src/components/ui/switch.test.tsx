import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Switch } from './switch';

describe('Switch', () => {
  it('toggles aria-checked on click', async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Enable" />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});
