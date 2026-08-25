import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChipInput } from './ChipInput';

describe('ChipInput', () => {
  it('renders existing values as removable chips inside a listbox', () => {
    render(
      <ChipInput
        values={['India', 'Remote']}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        ariaLabel="Cities and countries rule"
      />,
    );
    const listbox = screen.getByRole('listbox', { name: 'Cities and countries rule' });
    expect(listbox).toBeInTheDocument();
    expect(screen.getByText('India')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove India' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Remote' })).toBeInTheDocument();
  });

  it('calls onRemove with the chip value when its remove button is clicked', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ChipInput
        values={['India']}
        onAdd={vi.fn()}
        onRemove={onRemove}
        ariaLabel="Cities and countries rule"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove India' }));
    expect(onRemove).toHaveBeenCalledWith('India');
  });

  it('trims whitespace before calling onAdd and clears the draft input', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <ChipInput
        values={[]}
        onAdd={onAdd}
        onRemove={vi.fn()}
        ariaLabel="Cities and countries rule"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Cities and countries rule' });
    await user.type(input, '  Bengaluru  ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith('Bengaluru');
    expect(input).toHaveValue('');
  });

  it('does not call onAdd for an empty or already-present value', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <ChipInput
        values={['India']}
        onAdd={onAdd}
        onRemove={vi.fn()}
        ariaLabel="Cities and countries rule"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).not.toHaveBeenCalled();

    const input = screen.getByRole('textbox', { name: 'Cities and countries rule' });
    await user.type(input, 'India');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('forwards an optional data-qa id onto the outer wrapper', () => {
    const { container } = render(
      <ChipInput
        values={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        ariaLabel="Allowed timezones rule"
        data-qa="geo-timezones-rule"
      />,
    );
    expect(container.querySelector('[data-qa="geo-timezones-rule"]')).not.toBeNull();
  });
});
