import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/utils';

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('grid w-full gap-2', className)}
      {...props}
    />
  );
}

// `children` is pulled out (rather than left inside `...props`) so a
// caller can pass `asChild` plus a single custom child element (e.g. task
// 18's `PacingPresetCard` — a "card" radio composed over the vendored
// `RadioGroupItem`, not the default dot) and have it actually render:
// without this, the hardcoded `RadioGroupPrimitive.Indicator` JSX below
// would always win over a `children` prop arriving via `...props` spread
// (literal JSX children take priority over a spread `children` key), so
// `asChild` composition was unreachable. The default dot classes are
// likewise skipped whenever a custom `children` is supplied — they're
// sized/shaped for the 16px dot and would otherwise bleed onto whatever
// custom child a caller renders instead.
function RadioGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={
        children
          ? className
          : cn(
              'group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input outline-none group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary',
              className,
            )
      }
      {...props}
    >
      {children ?? (
        <RadioGroupPrimitive.Indicator
          data-slot="radio-group-indicator"
          className="flex size-4 items-center justify-center"
        >
          <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
        </RadioGroupPrimitive.Indicator>
      )}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
