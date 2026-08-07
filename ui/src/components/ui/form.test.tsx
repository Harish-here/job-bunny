import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
  useFieldContext,
} from './form';

describe('form field composition', () => {
  it('wires FieldLabel htmlFor to the control id', () => {
    render(
      <Field>
        <FieldLabel>Company</FieldLabel>
        <FieldControl>
          <input />
        </FieldControl>
      </Field>,
    );
    const label = screen.getByText('Company');
    const input = screen.getByRole('textbox');
    expect(label).toHaveAttribute('for', input.id);
  });

  it('marks the control invalid and renders an alert when FieldError has children', () => {
    render(
      <Field invalid>
        <FieldControl>
          <input />
        </FieldControl>
        <FieldError>Required</FieldError>
      </Field>,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Required');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('renders nothing for FieldError with no children', () => {
    render(
      <Field>
        <FieldControl>
          <input />
        </FieldControl>
        <FieldError />
      </Field>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('includes the description id in aria-describedby even when valid', () => {
    render(
      <Field>
        <FieldControl>
          <input />
        </FieldControl>
        <FieldDescription>Helper text</FieldDescription>
      </Field>,
    );
    const input = screen.getByRole('textbox');
    const description = screen.getByText('Helper text');
    expect(input.getAttribute('aria-describedby')).toContain(description.id);
  });

  it('throws when useFieldContext is used outside a Field', () => {
    expect(() => renderHook(() => useFieldContext())).toThrow(
      'Field components must be used inside <Field>',
    );
  });
});
