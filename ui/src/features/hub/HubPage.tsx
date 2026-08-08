import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { navigate, type Route } from '../../lib/router';
import { configDocQuery } from '../settings/config.queries';
import { daemonQuery } from '../wizard/wizard.queries';
import { type HubDialogCardId, HubStepDialog } from './HubStepDialog';
import {
  cardStatus,
  groupFindings,
  HUB_CARDS,
  type HubCardId,
  type HubCardStatus,
  scheduleWarning,
} from './hub.model';
import { doctorQuery } from './hub.queries';

const RUN_COMMAND = 'jobbunny serve start';

type CardAction =
  | { kind: 'link'; label: string; route: Route }
  | { kind: 'dialog'; label: string; cardId: HubDialogCardId };

// One action per card, looked up by id — every action in THIS task is a
// plain Settings/Runs deep link. Task 6 changes exactly the
// persona-filters, search-urls, and integrations cases to choose, based on
// status, between this same deep link ('ok': real config exists, editing it
// is Settings' job) and a new dialog trigger (anything else: nothing
// configured yet). profile, schedule-daemon, pipeline-health never change.
function cardAction(id: HubCardId, status: HubCardStatus): CardAction {
  switch (id) {
    case 'profile':
      return {
        kind: 'link',
        label: 'Edit in Settings',
        route: { name: 'settings', section: 'profile' },
      };
    case 'schedule-daemon':
      return {
        kind: 'link',
        label: 'Edit in Settings',
        route: { name: 'settings', section: 'schedule' },
      };
    case 'pipeline-health':
      return { kind: 'link', label: 'View runs', route: { name: 'runs' } };
    case 'persona-filters':
      return status === 'ok'
        ? {
            kind: 'link',
            label: 'Edit in Settings',
            route: { name: 'settings', section: 'filters' },
          }
        : { kind: 'dialog', label: 'Set up', cardId: 'persona-filters' };
    case 'search-urls':
      return status === 'ok'
        ? {
            kind: 'link',
            label: 'Edit in Settings',
            route: { name: 'settings', section: 'search-urls' },
          }
        : { kind: 'dialog', label: 'Set up', cardId: 'search-urls' };
    case 'integrations':
      return status === 'ok'
        ? {
            kind: 'link',
            label: 'Edit in Settings',
            route: { name: 'settings', section: 'profile' },
          }
        : { kind: 'dialog', label: 'Set up', cardId: 'integrations' };
  }
}

// profile.json's `schedule` block has no dedicated read hook yet (task 8
// adds one) — this pulls out just enough for the banner, treating an
// empty/malformed/schedule-less doc as "no schedule" rather than throwing.
function readSchedule(text: string | undefined): { enabled: boolean; times: string[] } {
  if (text === undefined || text.trim() === '') return { enabled: false, times: [] };
  try {
    const parsed = JSON.parse(text) as {
      schedule?: { enabled?: boolean; times?: string[] };
    };
    const schedule = parsed.schedule;
    return {
      enabled: schedule?.enabled === true,
      times: Array.isArray(schedule?.times) ? schedule.times : [],
    };
  } catch {
    return { enabled: false, times: [] };
  }
}

export function HubPage({ profile }: { profile: string }) {
  const doctor = useQuery(doctorQuery(profile));
  const daemon = useQuery(daemonQuery());
  const profileConfig = useQuery(configDocQuery(profile, 'profile.json'));
  const [openCardId, setOpenCardId] = useState<HubDialogCardId | null>(null);

  const findings = doctor.data?.findings ?? [];
  const grouped = groupFindings(findings);

  const schedule = readSchedule(profileConfig.data?.text);
  const banner =
    daemon.isSuccess && profileConfig.isSuccess
      ? scheduleWarning({
          daemonState: daemon.data.state,
          scheduleEnabled: schedule.enabled,
          times: schedule.times,
        })
      : null;

  return (
    <div data-testid="hub" className="flex h-screen flex-col gap-6 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold font-heading">Setup & Health</h1>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate({ name: 'onboarding' })}
        >
          Set up a new profile
        </Button>
      </div>

      {!doctor.isSuccess && <p className="text-sm text-muted-foreground">Loading…</p>}

      {banner && (
        <div
          role="alert"
          data-testid="hub-banner"
          className="flex flex-col gap-1 rounded-lg border border-attention bg-attention/10 p-3 text-sm"
        >
          <p>Scheduled for {banner.firstTime} but the daemon isn't running</p>
          <code className="font-mono text-xs">{RUN_COMMAND}</code>
        </div>
      )}

      {doctor.isSuccess && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HUB_CARDS.map((card) => {
            const cardFindings = grouped[card.id];
            const status = cardStatus(cardFindings);
            const action = cardAction(card.id, status);
            return (
              <Card
                key={card.id}
                data-testid="hub-card"
                data-card-id={card.id}
                data-status={status}
              >
                <CardHeader>
                  <CardTitle>{card.title}</CardTitle>
                  <CardDescription>{card.blurb}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {cardFindings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No findings yet.</p>
                  ) : (
                    cardFindings.map((f) => (
                      <p
                        key={f.check}
                        data-testid="hub-finding"
                        className="text-sm text-muted-foreground"
                      >
                        {f.detail}
                      </p>
                    ))
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      action.kind === 'link'
                        ? navigate(action.route)
                        : setOpenCardId(action.cardId)
                    }
                  >
                    {action.label}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {openCardId && (
        <HubStepDialog
          profile={profile}
          cardId={openCardId}
          onClose={() => setOpenCardId(null)}
        />
      )}
    </div>
  );
}
