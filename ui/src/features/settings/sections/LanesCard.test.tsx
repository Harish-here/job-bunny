import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanesCard } from './LanesCard';

describe('LanesCard', () => {
  it('renders a checkbox per lane, checked per the given lanes list', () => {
    render(<LanesCard lanes={['linkedin']} onToggle={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'LinkedIn' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Greenhouse' })).not.toBeChecked();
  });

  it('fires onToggle with the lane name on click', () => {
    const onToggle = vi.fn();
    render(<LanesCard lanes={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keka' }));
    expect(onToggle).toHaveBeenCalledWith('keka');
  });
});
