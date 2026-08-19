/**
 * "Delivery" settings section (blueprint.md:850-861, step 21's component
 * half) — where results go: the connector, the Notion mirror settings, and
 * the Telegram notifier.
 *
 * Connector (R11) is deliberately **read-only display**, not a form
 * control: a plain `<span>` + explanatory copy, no `<select>` at all — the
 * `<select>` in `ProfileSection.tsx` is the control being DELETED from the
 * product (task 23), never migrated here in any form (not even disabled —
 * a disabled control reads as "temporarily can't touch this", the opposite
 * of "this is a migration, not a setting"). This section therefore never
 * writes `cfg.connector` back on save.
 *
 * Notion `mirror`/`dryRun` are two currently-unsurfaced booleans
 * (`profile.json.settings.notion.*`) — the first form surface for them.
 *
 * Telegram notifier is extracted unchanged from `ProfileSection.tsx`: the
 * bare checkbox plus the save-time "keep everything that isn't 'telegram',
 * then add it back conditionally" merge against `profile.json.notifiers`.
 *
 * No secret VALUE (Notion token, Telegram bot token) is rendered or
 * requested here — token entry lives on the Operate page's secrets card.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Field, FieldControl, FieldLabel } from '../../../components/ui/form';
import { Switch } from '../../../components/ui/switch';
import { DocFormGate } from '../DocFormGate';
import { SaveBar } from '../save/SaveBar';
import { useSectionSaveState } from '../save/useSectionSaveState';
import { useDocForm } from '../useDocForm';

interface DeliveryState {
  mirror: boolean;
  dryRun: boolean;
  telegramEnabled: boolean;
}

// `dryRun` defaults `true` (CLAUDE.md's documented default — a profile with
// no `settings.notion` block at all is not silently live-mirroring).
// `mirror` is opt-in, so it defaults `false`.
const DEFAULTS: DeliveryState = { mirror: false, dryRun: true, telegramEnabled: false };

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function parseDeliveryState(profileDoc: Record<string, unknown>): DeliveryState {
  const settings = asRecord(profileDoc.settings);
  const notion = asRecord(settings.notion);
  return {
    mirror: typeof notion.mirror === 'boolean' ? notion.mirror : DEFAULTS.mirror,
    dryRun: typeof notion.dryRun === 'boolean' ? notion.dryRun : DEFAULTS.dryRun,
    telegramEnabled: asStringArray(profileDoc.notifiers).includes('telegram'),
  };
}

// Delivery → profile.json's connector (read-only), `settings.notion.*`
// (mirror/dryRun) and `notifiers` (telegram) only. `lanes`/`routines` stay
// ProfileSection's job in this brief.
export function DeliverySection({ profile }: { profile: string }) {
  const docForm = useDocForm(profile, 'profile.json');

  const [connector, setConnector] = useState<'sqlite' | 'notion'>('sqlite');
  const [state, setState] = useState<DeliveryState>(DEFAULTS);
  const [savedState, setSavedState] = useState<DeliveryState>(DEFAULTS);

  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (docForm.isLoading || docForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const value = docForm.value;
    setConnector(value.connector === 'notion' ? 'notion' : 'sqlite');
    const parsed = parseDeliveryState(value);
    setState(parsed);
    setSavedState(parsed);
  }, [profile, docForm.isLoading, docForm.value]);

  function handleSave(value: DeliveryState): Promise<boolean> {
    return docForm.save((cfg) => {
      const settings = asRecord(cfg.settings);
      const notion = asRecord(settings.notion);
      cfg.settings = {
        ...settings,
        notion: { ...notion, mirror: value.mirror, dryRun: value.dryRun },
      };
      const otherNotifiers = asStringArray(cfg.notifiers).filter((n) => n !== 'telegram');
      cfg.notifiers = value.telegramEnabled
        ? [...otherNotifiers, 'telegram']
        : otherNotifiers;
    });
  }

  const saveState = useSectionSaveState({
    profile,
    initialValue: savedState,
    currentValue: state,
    validate: () => ({}),
    onSave: async (value) => {
      const ok = await handleSave(value);
      if (ok) setSavedState(value);
    },
  });

  return (
    <DocFormGate
      doc="profile.json"
      isLoading={docForm.isLoading}
      loadError={docForm.loadError}
      parseError={docForm.parseError}
    >
      <div className="flex flex-col gap-4">
        <Card data-qa="delivery-connector-card">
          <CardHeader>
            <CardTitle>Connector</CardTitle>
            <CardDescription>Where this profile's jobs are stored.</CardDescription>
          </CardHeader>
          <CardContent>
            <div data-testid="delivery-connector-field" className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Connector: {connector}</span>
              <p className="text-sm text-muted-foreground">
                Set at profile creation; changing it is a migration, not a setting.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card data-qa="delivery-notion-card">
          <CardHeader>
            <CardTitle>Notion mirror</CardTitle>
            <CardDescription>
              Opt-in, one-way, best-effort push to Notion — it never blocks, stalls or
              fails a run.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field data-qa="delivery-notion-mirror">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel>Mirror to Notion</FieldLabel>
                <FieldControl>
                  <Switch
                    checked={state.mirror}
                    onCheckedChange={(mirror) =>
                      setState((prev) => ({ ...prev, mirror }))
                    }
                  />
                </FieldControl>
              </div>
            </Field>
            <Field data-qa="delivery-notion-dry-run">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel>Dry run</FieldLabel>
                <FieldControl>
                  <Switch
                    checked={state.dryRun}
                    onCheckedChange={(dryRun) =>
                      setState((prev) => ({ ...prev, dryRun }))
                    }
                  />
                </FieldControl>
              </div>
            </Field>
          </CardContent>
        </Card>

        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={state.telegramEnabled}
            onChange={(e) =>
              setState((prev) => ({ ...prev, telegramEnabled: e.target.checked }))
            }
          />
          Telegram notifier
        </label>

        {docForm.serverError && (
          <p data-testid="settings-error" className="text-sm text-destructive">
            {docForm.serverError}
          </p>
        )}

        <SaveBar
          isDirty={saveState.isDirty}
          errors={saveState.errors}
          successMessage={saveState.successMessage}
          onSave={saveState.save}
          onDiscard={() => setState(saveState.discard())}
        />
      </div>
    </DocFormGate>
  );
}
