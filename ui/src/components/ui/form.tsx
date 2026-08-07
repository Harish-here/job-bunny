import { Label as LabelPrimitive, Slot } from 'radix-ui';
import type * as React from 'react';
import { createContext, useContext, useId } from 'react';

import { cn } from '@/lib/utils';

type FieldContextValue = {
  id: string;
  descriptionId: string;
  errorId: string;
  invalid: boolean;
};

const FieldContext = createContext<FieldContextValue | null>(null);

function useFieldContext(): FieldContextValue {
  const ctx = useContext(FieldContext);
  if (!ctx) throw new Error('Field components must be used inside <Field>');
  return ctx;
}

function Field({
  className,
  invalid = false,
  ...props
}: React.ComponentProps<'div'> & { invalid?: boolean }) {
  const id = useId();
  const value: FieldContextValue = {
    id,
    descriptionId: `${id}-description`,
    errorId: `${id}-error`,
    invalid,
  };
  return (
    <FieldContext.Provider value={value}>
      <div
        data-slot="field"
        className={cn('flex flex-col gap-1.5', className)}
        {...props}
      />
    </FieldContext.Provider>
  );
}

function FieldLabel({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const { id } = useFieldContext();
  return (
    <LabelPrimitive.Root
      data-slot="field-label"
      htmlFor={id}
      className={cn('text-sm leading-none font-medium', className)}
      {...props}
    />
  );
}

function FieldControl({ ...props }: React.ComponentProps<typeof Slot.Root>) {
  const { id, descriptionId, errorId, invalid } = useFieldContext();
  return (
    <Slot.Root
      data-slot="field-control"
      id={id}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${descriptionId} ${errorId}` : descriptionId}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  const { descriptionId } = useFieldContext();
  return (
    <p
      id={descriptionId}
      data-slot="field-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function FieldError({ className, children, ...props }: React.ComponentProps<'p'>) {
  const { errorId } = useFieldContext();
  if (!children) return null;
  return (
    <p
      id={errorId}
      role="alert"
      data-slot="field-error"
      className={cn('text-sm text-destructive', className)}
      {...props}
    >
      {children}
    </p>
  );
}

export { Field, FieldControl, FieldDescription, FieldError, FieldLabel, useFieldContext };
