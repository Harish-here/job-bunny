import { ChevronsRight, Circle, Minus, Send, Star } from 'lucide-react';
import type { ComponentProps, ReactElement } from 'react';

type StatusPipProps = { status: string | null } & Omit<
  ComponentProps<'span'>,
  'children'
>;

/**
 * The icon + aria-label for a tracking status, per the 5-state glyph table
 * (`ux-notes.md` §6): `null` -> hollow Circle, `Lead` -> filled Star,
 * `Applied` -> Send, `Passed`/`Rejected` -> Minus (destructive), everything
 * else (the 4-value "in play" group — Recruiter Screen/Tech Round/Onsite/
 * Offer — plus any other non-null, non-closed status, matching JobRow.tsx's
 * existing `dotClass` fallback precedent) -> ChevronsRight, `text-primary`
 * except `Offer`, which uses `text-success-strong` (not plain `--success`,
 * which fails AA for a stroke-only icon; not `--primary`) to match the
 * mockup's own literal Offer-row markup.
 */
function pipFor(status: string | null): { icon: ReactElement; label: string } {
  if (status === null) {
    return {
      icon: <Circle aria-hidden="true" className="size-3 text-muted-foreground/40" />,
      label: 'Not decided',
    };
  }
  if (status === 'Lead') {
    return {
      icon: (
        <Star aria-hidden="true" className="size-3 text-primary" fill="currentColor" />
      ),
      label: 'Lead',
    };
  }
  if (status === 'Applied') {
    return {
      icon: <Send aria-hidden="true" className="size-3 text-primary" />,
      label: 'Applied',
    };
  }
  if (status === 'Passed' || status === 'Rejected') {
    return {
      icon: <Minus aria-hidden="true" className="size-3 text-destructive" />,
      label: status,
    };
  }
  return {
    icon: (
      <ChevronsRight
        aria-hidden="true"
        className={
          status === 'Offer' ? 'size-3 text-success-strong' : 'size-3 text-primary'
        }
      />
    ),
    label: status,
  };
}

/**
 * Non-colour tracking-status glyph (R15: colour is a third cue layered on
 * top of icon shape, never the only signal — the S12 greyscale proof
 * confirms all 5 states stay distinguishable with hue stripped). Forwards
 * arbitrary native `<span>` props via `...rest` so a later caller (task 6,
 * `JobRow.tsx`) can move its `data-testid`/`title` onto this root without
 * forking or wrapping `StatusPip` — the component's own `data-qa` and
 * `aria-label` are applied after the spread, so they always win.
 */
export function StatusPip({ status, ...rest }: StatusPipProps) {
  const { icon, label } = pipFor(status);
  return (
    <span {...rest} data-qa="job-row-pip" role="img" aria-label={label}>
      {icon}
    </span>
  );
}
