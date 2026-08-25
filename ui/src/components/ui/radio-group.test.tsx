import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RadioGroup, RadioGroupItem } from './radio-group';

describe('RadioGroupItem', () => {
  it('renders the default dot indicator when no children are supplied', () => {
    const { container } = render(
      <RadioGroup value="a">
        <RadioGroupItem value="a" />
      </RadioGroup>,
    );
    expect(container.querySelector('[data-slot="radio-group-indicator"]')).not.toBeNull();
  });

  it('asChild + a custom child renders the child instead of the dot, with radio semantics merged onto it', () => {
    render(
      <RadioGroup value="b" aria-label="pick one">
        <RadioGroupItem value="a" asChild>
          <button type="button">Option A</button>
        </RadioGroupItem>
        <RadioGroupItem value="b" asChild>
          <button type="button">Option B</button>
        </RadioGroupItem>
      </RadioGroup>,
    );
    const optionA = screen.getByRole('radio', { name: 'Option A' });
    const optionB = screen.getByRole('radio', { name: 'Option B' });
    expect(optionA).toHaveAttribute('data-state', 'unchecked');
    expect(optionB).toHaveAttribute('data-state', 'checked');
  });
});
