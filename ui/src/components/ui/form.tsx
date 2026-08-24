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
  id,
  ...props
}: React.ComponentProps<'div'> & { invalid?: boolean }) {
  // `id`, when the caller supplies one, becomes the CONTROL's own DOM id
  // (via `FieldContext`, consumed by `FieldControl` below) — not merely
  // the wrapping `<div>`'s id, which would do nothing for a caller that
  // needs a stable, predictable id on the actual input (B2, QA
  // settings-overhaul: the validation summary's "click a link, focus the
  // field" contract needs the rendered `<input>`'s id to equal the
  // field's error key). Falls back to `useId()` exactly as before when no
  // `id` is passed, so every existing caller is unaffected.
  const generatedId = useId();
  const resolvedId = id ?? generatedId;
  const value: FieldContextValue = {
    id: resolvedId,
    descriptionId: `${resolvedId}-description`,
    errorId: `${resolvedId}-error`,
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
