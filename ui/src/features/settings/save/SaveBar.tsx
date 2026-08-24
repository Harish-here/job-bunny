import { Button } from '../../../components/ui/button';

export interface SaveBarProps {
  isDirty: boolean;
  successMessage: string | null;
  /** Wraps `useSectionSaveState`'s (task 4) own `save`. Always called on
   * click, unconditionally — `save-button` is NEVER `disabled`; the hook's
   * own `save()` is what refuses to call the caller's `onSave` when
   * validation fails (task 4's job, already built). Returns whether the
   * save actually persisted — the same `Promise<boolean>` contract
   * `SettingsSaveContext`'s `useRegisterSettingsSave` and `DirtyNavGuard`
   * depend on; `SaveBar` itself ignores the resolved value (its own click
   * handler discards it), it only needs the type to line up so every
   * caller can hand the SAME `save` reference to both `SaveBar` and the
   * registration hook. */
  onSave: () => Promise<boolean>;
  /** Wraps `useSectionSaveState`'s `discard`; the caller is responsible for
   * applying `discard()`'s returned value back onto its own draft state
   * (e.g. `onDiscard={() => setCurrentValue(discard())}`). */
  onDiscard: () => void;
  /** Purely visual de-emphasis, never a validation gate (`save-button` is
   * NEVER `disabled` — see the field above). Defaults to `'default'`;
   * WhereYouWorkSection (task 11) passes `'outline'` while its
   * `geo-conflict-notice` is the screen's one visually distinct element,
   * so the save button doesn't compete with it. */
  saveButtonVariant?: 'default' | 'outline';
}

/**
 * The S8 save model's sticky bar (blueprint.md:479-496). Renders exactly one
 * of three states, in priority order: dirty bar (unsaved) > success line
 * (just saved) > idle (nothing).
 *
 * B1 fix (QA settings-overhaul): this used to ALSO render the validation
 * summary as a fourth, higher-priority state — which unmounted the
 * Save/Discard buttons the instant a submit failed, taking the primary
 * action away exactly when the user needed it most. The summary now lives
 * in `ValidationSummary.tsx`, rendered by each section at the TOP of its
 * content column (ux-notes §11: "an error summary card at the top of the
 * content column"), so the two are no longer mutually exclusive — a
 * failed submit leaves `isDirty` true (the draft still differs from the
 * saved value), so the dirty bar keeps rendering underneath it, Save
 * button included, never disabled.
 */
export function SaveBar({
  isDirty,
  successMessage,
  onSave,
  onDiscard,
  saveButtonVariant = 'default',
}: SaveBarProps) {
  if (isDirty) {
    return (
      <div
        data-qa="save-bar"
        data-testid="save-bar"
        className="sticky bottom-0 flex items-center justify-between gap-3 rounded-xl bg-card p-3 shadow-lg ring-1 ring-foreground/10"
      >
        <span className="text-sm">Unsaved changes</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-qa="discard-button"
            data-testid="discard-button"
            onClick={onDiscard}
          >
            Discard
          </Button>
          <Button
            type="button"
            variant={saveButtonVariant}
            size="sm"
            data-qa="save-button"
            data-testid="save-button"
            onClick={onSave}
          >
            Save changes
          </Button>
        </div>
      </div>
    );
  }

  if (successMessage !== null) {
    return (
      <div
        data-qa="save-success-line"
        data-testid="save-success-line"
        className="flex items-center justify-between gap-3 rounded-xl border-l-2 border-l-success bg-success/10 p-3 text-sm"
      >
        <span>{successMessage}</span>
      </div>
    );
  }

  return null;
}
