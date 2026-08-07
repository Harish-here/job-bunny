import { cn } from '../../lib/utils';
import type { MascotState } from './mascotState';

const LABELS: Record<MascotState, string> = {
  asleep: 'Bunny is asleep',
  'ears-up': 'Bunny is waiting for the daemon',
  hopping: 'Bunny is running the pipeline',
  celebrating: 'Bunny found new matches',
};

// The "needs you" carrot accent belongs to ears-up (waiting on the daemon);
// celebrating gets the clover success accent; hopping (an active, neutral
// state, not a signal) gets the brand violet; asleep is muted.
const ACCENT_CLASS: Record<MascotState, string> = {
  asleep: 'fill-muted-foreground',
  'ears-up': 'fill-attention',
  hopping: 'fill-primary',
  celebrating: 'fill-success',
};

const ANIMATION_CLASS: Record<MascotState, string> = {
  asleep: '',
  'ears-up': '',
  hopping: 'animate-[lapin-hop_600ms_ease-in-out_infinite]',
  celebrating: 'animate-[lapin-cheer_800ms_ease-in-out_infinite]',
};

/** Ears folded flat when asleep, standing tall in every other state — pose
 * alone tells "resting" from "alert" at a glance. Un-styled: `fill`
 * inherits from the root <svg>'s ACCENT_CLASS below. */
function Ears({ state }: { state: MascotState }) {
  if (state === 'asleep') {
    return (
      <>
        <rect x="4" y="6" width="11" height="4" rx="2" />
        <rect x="21" y="6" width="11" height="4" rx="2" />
      </>
    );
  }
  return (
    <>
      <rect x="8" y="1" width="5" height="15" rx="2.5" />
      <rect x="23" y="1" width="5" height="15" rx="2.5" />
    </>
  );
}

/** Eyes closed (a thin bar) when asleep, open (a dot) otherwise — punched
 * out of the body via the `background` token so they read as holes
 * regardless of the mascot's current accent colour. */
function Eyes({ state }: { state: MascotState }) {
  if (state === 'asleep') {
    return (
      <>
        <rect
          x="12"
          y="20"
          width="4"
          height="1.5"
          rx="0.75"
          className="fill-background"
        />
        <rect
          x="20"
          y="20"
          width="4"
          height="1.5"
          rx="0.75"
          className="fill-background"
        />
      </>
    );
  }
  return (
    <>
      <circle cx="14" cy="20" r="1.5" className="fill-background" />
      <circle cx="22" cy="20" r="1.5" className="fill-background" />
    </>
  );
}

/** Three sparkles around the body — celebrating only. Un-styled, same
 * fill-inheritance as the ears. */
function Sparkles() {
  return (
    <>
      <circle cx="2" cy="10" r="1.5" />
      <circle cx="34" cy="6" r="1.5" />
      <circle cx="31" cy="25" r="1.5" />
    </>
  );
}

export function Mascot({ state, className }: { state: MascotState; className?: string }) {
  return (
    <span
      data-testid="mascot"
      data-state={state}
      role="img"
      aria-label={LABELS[state]}
      className={cn('inline-block', className)}
    >
      <svg
        viewBox="0 0 36 36"
        width="32"
        height="32"
        aria-hidden="true"
        className={cn(ACCENT_CLASS[state], ANIMATION_CLASS[state])}
      >
        <Ears state={state} />
        <ellipse cx="18" cy="22" rx="11" ry="9" />
        <Eyes state={state} />
        {state === 'celebrating' && <Sparkles />}
      </svg>
    </span>
  );
}
