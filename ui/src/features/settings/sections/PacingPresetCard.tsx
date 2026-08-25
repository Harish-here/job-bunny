/**
 * One card inside `FetchingSection`'s `pacing-presets` radiogroup
 * (blueprint.md:830-846, step 20). Wraps the vendored `RadioGroupItem`
 * (task 3) `asChild` around a real `<button role="radio">` — the mockup's
 * `preset-card` markup is a static demo; this makes it an actually
 * accessible radio button, per `mockup-fragment.html`'s `preset-card`
 * shape (`role="radio"`, `aria-checked`, `aria-describedby` pointing at
 * the consequence text).
 *
 * The Fast card ONLY renders its warning (`pacing-fast-warning`, the
 * vendored `Alert`) and the acknowledgement checkbox (`pacing-fast-ack`) —
 * both CHILDREN of this card, never a page-level fixture (ux-notes C5:
 * present on 95% of visits where nothing risky happens, learned past by
 * the third). The ack's checked state is owned by `FetchingSection`
 * (passed down as `fastAck`/`onFastAckChange`), not local state here — the
 * clear-on-preset-switch behaviour has to reach across a preset change,
 * which a state value scoped to one card's own lifetime cannot do (this
 * card unmounts/remounts as nothing changes preset identity, but the
 * *selection* moving to a different card can't clear a sibling's local
 * state).
 */
import { AlertTriangle } from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../../components/ui/accordion';
import { Alert, AlertDescription } from '../../../components/ui/alert';
import { Badge } from '../../../components/ui/badge';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { RadioGroupItem } from '../../../components/ui/radio-group';
import { cn } from '../../../lib/utils';
import type { PacingPresetName } from './fetching.model';

const PRESET_META: Record<PacingPresetName, { name: string; consequence: string }> = {
  safe: {
    name: 'Safe',
    consequence: '8–18s between pages · 35–70s between searches · ~40% slower runs',
  },
  normal: {
    name: 'Normal',
    consequence: '5–12s between pages · 20–45s between searches · the shipped default',
  },
  fast: {
    name: 'Fast',
    consequence: '2–5s between pages · 8–15s between searches',
  },
};

// Ack is NOT a save-blocking validator (pinned in ux-notes: it must be
// checked to acknowledge risk, never stated as blocking save) — do not add
// validation logic here that refuses Save on an unchecked ack.
const FAST_WARNING_COPY =
  'Faster than LinkedIn tolerates. A soft-block stops all LinkedIn scraping for 4 hours; repeat blocks risk the account.';
const FAST_ACK_LABEL = 'I understand this risks a soft-block';

export function PacingPresetCard({
  preset,
  isCurrent,
  fastAck,
  onFastAckChange,
}: {
  preset: PacingPresetName;
  /** True when this card's preset is the profile's currently SAVED
   * (active) preset — independent of what's selected in the draft, which
   * is what the `ring-2`/`data-state=checked` styling reflects instead. */
  isCurrent: boolean;
  fastAck: boolean;
  onFastAckChange: (checked: boolean) => void;
}) {
  const meta = PRESET_META[preset];
  const descId = `pacing-preset-${preset}-desc`;
  const isFast = preset === 'fast';

  return (
    <RadioGroupItem value={preset} asChild>
      <button
        type="button"
        data-qa={`pacing-preset-${preset}`}
        aria-describedby={descId}
        className={cn(
          'flex flex-col items-start gap-1.5 rounded-lg border border-border bg-card p-3 text-left text-sm',
          'data-[state=checked]:ring-2 data-[state=checked]:ring-primary',
          // B8 fix (QA settings-overhaul, round 2): mockup.html:163
          // (`.preset-card.attention{border-left:2px solid var(--attention)}`)
          // applies to the Fast card UNCONDITIONALLY — the class is static
          // markup, never toggled by `setPreset()` — so this stays regardless
          // of `isCurrent`/selection state. `border-l-attention` (per-side
          // color), not `border-attention` (all-sides color): the mockup's
          // other three edges stay the base `--border`.
          isFast && 'border-l-2 border-l-attention',
        )}
      >
        <span className="flex items-center gap-1.5 font-medium">
          {meta.name}
          {isCurrent && <Badge variant="outline">current</Badge>}
        </span>
        <span id={descId} className="text-xs text-muted-foreground">
          {meta.consequence}
        </span>
        {isFast && (
          <>
            <Alert
              data-qa="pacing-fast-warning"
              className="mt-1 border-l-2 border-l-attention bg-attention/10"
            >
              <AlertTriangle className="text-attention" />
              <AlertDescription>{FAST_WARNING_COPY}</AlertDescription>
            </Alert>
            <label
              data-qa="pacing-fast-ack"
              className="mt-1 flex items-center gap-1.5 text-xs"
            >
              <input
                type="checkbox"
                checked={fastAck}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onFastAckChange(event.target.checked)}
              />
              {FAST_ACK_LABEL}
            </label>
          </>
        )}
      </button>
    </RadioGroupItem>
  );
}

type RawFieldKey =
  | 'jitterMinMs'
  | 'jitterMaxMs'
  | 'interUrlDelayMinMs'
  | 'interUrlDelayMaxMs';

const RAW_FIELDS: Array<{ key: RawFieldKey; label: string; dataQa: string }> = [
  { key: 'jitterMinMs', label: 'jitterMinMs', dataQa: 'pacing-raw-jitter-min' },
  { key: 'jitterMaxMs', label: 'jitterMaxMs', dataQa: 'pacing-raw-jitter-max' },
  {
    key: 'interUrlDelayMinMs',
    label: 'interUrlDelayMinMs',
    dataQa: 'pacing-raw-inter-url-min',
  },
  {
    key: 'interUrlDelayMaxMs',
    label: 'interUrlDelayMaxMs',
    dataQa: 'pacing-raw-inter-url-max',
  },
];

/**
 * The "Advanced — raw millisecond values" disclosure — built here (per the
 * brief's own step 2) and composed by `FetchingSection` as part of the same
 * pacing card. Collapsed by default (`Accordion` with no `defaultValue`);
 * `AccordionTrigger` sets `aria-expanded` itself. Editing any field is the
 * caller's job (`onFieldChange`) — this component owns no state of its
 * own, matching every other raw-value input on this page.
 *
 * `errors` is keyed by the same `RawFieldKey`s and rendered the same way
 * `FetchingSection`'s own `CAP_FIELDS` render theirs (`Field invalid` +
 * `FieldError`) — this component owns no validation logic itself, it only
 * displays whatever the caller's `useSectionSaveState().errors` already
 * computed (R13, task 28 gap fix), so the R13 cross-field pacing invariant
 * (`jitterMinMs <= jitterMaxMs`) surfaces here the same way it surfaces in
 * the SaveBar's validation summary.
 */
export function PacingAdvancedDisclosure({
  jitterMinMs,
  jitterMaxMs,
  interUrlDelayMinMs,
  interUrlDelayMaxMs,
  onFieldChange,
  errors,
}: {
  jitterMinMs: number;
  jitterMaxMs: number;
  interUrlDelayMinMs: number;
  interUrlDelayMaxMs: number;
  onFieldChange: (field: RawFieldKey, raw: string) => void;
  errors?: Partial<Record<RawFieldKey, string>>;
}) {
  const values: Record<RawFieldKey, number> = {
    jitterMinMs,
    jitterMaxMs,
    interUrlDelayMinMs,
    interUrlDelayMaxMs,
  };

  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="advanced">
        <AccordionTrigger data-qa="pacing-advanced-disclosure">
          Advanced — raw millisecond values
        </AccordionTrigger>
        <AccordionContent>
          <div className="grid grid-cols-2 gap-4">
            {RAW_FIELDS.map((field) => {
              const error = errors?.[field.key];
              return (
                <Field
                  key={field.key}
                  id={`fetching.${field.key}`}
                  data-qa={field.dataQa}
                  invalid={Boolean(error)}
                >
                  <FieldLabel>{field.label}</FieldLabel>
                  <FieldControl>
                    <Input
                      type="number"
                      value={String(values[field.key])}
                      onChange={(e) => onFieldChange(field.key, e.target.value)}
                    />
                  </FieldControl>
                  <FieldError>{error}</FieldError>
                </Field>
              );
            })}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
