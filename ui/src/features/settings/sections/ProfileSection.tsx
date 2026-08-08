import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useDocForm } from '../useDocForm';

const CONNECTORS = ['sqlite', 'notion'] as const;
const LANES = ['linkedin', 'greenhouse', 'keka'] as const;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

// Profile → profile.json's connector/lanes/notifiers/routines; `settings` is deliberately not form-edited here — see Rationale.
export function ProfileSection({ profile }: { profile: string }) {
  const docForm = useDocForm(profile, 'profile.json');
  const [connector, setConnector] = useState<'sqlite' | 'notion'>('sqlite');
  const [lanes, setLanes] = useState<string[]>([]);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [routines, setRoutines] = useState<string[]>([]);
  const [newRoutine, setNewRoutine] = useState('');

  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (docForm.isLoading || docForm.value == null) return;
    if (initialized.current === profile) return;
    initialized.current = profile;
    const value = docForm.value;
    setConnector(value.connector === 'notion' ? 'notion' : 'sqlite');
    // Local `lanes` state tracks ONLY the three known lane names — mirrors
    // `handleSave`'s own split, which re-derives any unknown entry fresh
    // from the doc at save time rather than carrying it through this
    // state. Seeding this with the doc's raw (unfiltered) array would
    // double up any unknown entry on save (`otherLanes` re-adds it AND
    // this state already has it).
    setLanes(
      asStringArray(value.lanes).filter((l) => (LANES as readonly string[]).includes(l)),
    );
    setTelegramEnabled(asStringArray(value.notifiers).includes('telegram'));
    setRoutines(asStringArray(value.routines));
  }, [profile, docForm.isLoading, docForm.value]);

  function toggleLane(lane: string) {
    setLanes((prev) =>
      prev.includes(lane) ? prev.filter((l) => l !== lane) : [...prev, lane],
    );
  }

  function addRoutine() {
    const trimmed = newRoutine.trim();
    if (trimmed === '' || routines.includes(trimmed)) return;
    setRoutines((prev) => [...prev, trimmed]);
    setNewRoutine('');
  }

  function removeRoutine(name: string) {
    setRoutines((prev) => prev.filter((r) => r !== name));
  }

  async function handleSave() {
    await docForm.save((cfg) => {
      cfg.connector = connector;
      const otherLanes = asStringArray(cfg.lanes).filter(
        (l) => !(LANES as readonly string[]).includes(l),
      );
      cfg.lanes = [...otherLanes, ...lanes];
      const otherNotifiers = asStringArray(cfg.notifiers).filter((n) => n !== 'telegram');
      cfg.notifiers = telegramEnabled ? [...otherNotifiers, 'telegram'] : otherNotifiers;
      cfg.routines = routines;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm leading-none font-medium">Connector</span>
        <select
          aria-label="Connector"
          value={connector}
          onChange={(e) => setConnector(e.target.value as 'sqlite' | 'notion')}
          className="h-8 w-fit rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {CONNECTORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm leading-none font-medium">Lanes</span>
        <div className="flex flex-wrap gap-3">
          {LANES.map((lane) => (
            <label key={lane} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={lanes.includes(lane)}
                onChange={() => toggleLane(lane)}
              />
              {lane}
            </label>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          checked={telegramEnabled}
          onChange={(e) => setTelegramEnabled(e.target.checked)}
        />
        Telegram notifier
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm leading-none font-medium">Routines</span>
        <div className="flex flex-wrap gap-1.5">
          {routines.map((name) => (
            <Badge key={name} variant="secondary">
              <span>{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => removeRoutine(name)}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            aria-label="Add routine"
            value={newRoutine}
            onChange={(e) => setNewRoutine(e.target.value)}
          />
          <Button type="button" variant="outline" size="sm" onClick={addRoutine}>
            Add
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Notion and Telegram settings are configured from Setup &amp; Health →
        Integrations, or through Edit as JSON.
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={docForm.isSaving} onClick={handleSave}>
          Save
        </Button>
        {docForm.isSaving && (
          <span className="text-xs text-muted-foreground">Saving…</span>
        )}
      </div>
      {docForm.serverError && (
        <p data-testid="settings-error" className="text-sm text-destructive">
          {docForm.serverError}
        </p>
      )}
    </div>
  );
}
