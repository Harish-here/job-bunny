import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { navigate, type Route } from '../../lib/router';
import {
  CHECK_TO_DESTINATION,
  type CheckDestination,
  groupHealthFindings,
  type HealthGroupId,
} from './checkDestination';
import type { DoctorFinding, DoctorStatus } from './operate.api';
import { doctorQuery } from './operate.queries';

// hub.model.ts's now-superseded HubCardStatus tone idiom, keyed by
// DoctorStatus instead of a card-level rollup — 'warn' deliberately
// resolves to 'attention', not 'amber': the design scale flags plain
// `--amber` as failing 4.5:1 for body text and defines no
// `--amber-strong` counterpart, where `--attention-strong` exists exactly
// for this (see DaemonCard.tsx's own TONE_WORD_CLASS precedent).
type FindingTone = 'success' | 'attention' | 'destructive';
const STATUS_TONE: Record<DoctorStatus, FindingTone> = {
  ok: 'success',
  warn: 'attention',
  red: 'destructive',
};
const TONE_WORD_CLASS: Record<FindingTone, string> = {
  success: 'text-success-strong',
  attention: 'text-attention-strong',
  destructive: 'text-destructive',
};
const TONE_DOT_CLASS: Record<FindingTone, string> = {
  success: 'bg-success',
  attention: 'bg-attention',
  destructive: 'bg-destructive',
};

const GROUP_LABEL: Record<Exclude<HealthGroupId, 'ok'>, string> = {
  'needs-action': 'Needs action',
  'not-configured': 'Not configured',
};

/** The `[Copy: <command>]` affordance for a `cli-command` destination —
 * the board never performs a setup step, only hands over the command to
 * run. Same transient "Copied" feedback as `RunNowButton.tsx`'s
 * `CopyServeStartButton` and the wizard's `Step6Launch.tsx`; kept local
 * for the same reason those two are kept local to each other — different
 * render context, one small handler, not worth exporting across a
 * feature boundary. */
function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser sandbox — the
      // command still renders in the label, copyable by hand.
    }
  }

  return (
    <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
      {copied ? 'Copied' : `Copy: ${command}`}
    </Button>
  );
}

/** The per-row destination control: a `settings-link` navigates via the
 * hash router, a `cli-command` hands off to `CopyCommandButton`. `null`
 * destination (a check with no `CHECK_TO_DESTINATION` entry) renders
 * nothing but still carries the `data-qa` cell — a stable id even when
 * empty is preferable to a cell that sometimes doesn't exist. */
function destinationLabel(route: Route): string {
  return route.name === 'settings' ? 'Settings' : 'View runs';
}

function DestinationCell({
  check,
  destination,
}: {
  check: string;
  destination: CheckDestination | undefined;
}) {
  return (
    <td data-qa={`health-destination-${check}`} className="py-1.5 text-right">
      {destination?.kind === 'settings-link' && (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => navigate(destination.route)}
        >
          {destinationLabel(destination.route)}
        </Button>
      )}
      {destination?.kind === 'cli-command' && (
        <CopyCommandButton command={destination.command} />
      )}
    </td>
  );
}

function HealthRow({ finding }: { finding: DoctorFinding }) {
  const tone = STATUS_TONE[finding.status];
  return (
    <tr data-qa={`health-row-${finding.check}`}>
      <td className="py-1.5 pr-2">
        <span
          className={`inline-flex items-center gap-1 text-xs font-medium ${TONE_WORD_CLASS[tone]}`}
        >
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${TONE_DOT_CLASS[tone]}`}
          />
          {finding.detail}
        </span>
      </td>
      <DestinationCell
        check={finding.check}
        destination={CHECK_TO_DESTINATION[finding.check]}
      />
    </tr>
  );
}

/** A non-empty `Needs action`/`Not configured` group — rendered directly
 * (never behind a disclosure), because both groups exist specifically to
 * surface something that needs the user's attention right now. */
function HealthGroup({
  groupId,
  findings,
}: {
  groupId: Exclude<HealthGroupId, 'ok'>;
  findings: DoctorFinding[];
}) {
  if (findings.length === 0) return null;
  return (
    <div data-qa={`health-group-${groupId}`} className="flex flex-col gap-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {GROUP_LABEL[groupId]} ({findings.length})
      </p>
      <table className="w-full">
        <tbody>
          {findings.map((f) => (
            <HealthRow key={f.check} finding={f} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The `OK` group is always behind the single-item `Accordion` — closed
 * by default. When it is the ONLY group (every check passes) the trigger
 * reads the collapsed "Setup complete" line (mockup S6); otherwise it
 * reads a shorter summary, mirroring mockup S7's "N OK checks collapsed
 * below" note. A permanent all-green checklist is an element that says
 * nothing, so it never renders open by default in either case. */
function OkGroup({ findings, total }: { findings: DoctorFinding[]; total: number }) {
  if (findings.length === 0) return null;
  const allOk = findings.length === total;
  const triggerText = allOk
    ? `Setup complete · ${findings.length}/${total} checks passing`
    : `${findings.length} OK checks collapsed below`;
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="ok">
        <AccordionTrigger>{triggerText}</AccordionTrigger>
        <AccordionContent>
          <div data-qa="health-group-ok" className="flex flex-col gap-1">
            <table className="w-full">
              <tbody>
                {findings.map((f) => (
                  <HealthRow key={f.check} finding={f} />
                ))}
              </tbody>
            </table>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/** Operate's merged Setup & health card (blueprint step 35) — one card,
 * not two: the doctor projection IS the setup-completeness checklist, so
 * a second card would render the same 13-14 checks twice under two
 * headings. Self-fetches via `doctorQuery`, the same pattern
 * `DaemonCard.tsx`/`ScheduledRunsCard.tsx` already use. */
export function SetupHealthCard({ profile }: { profile: string }) {
  const doctor = useQuery(doctorQuery(profile));

  if (doctor.isError) {
    return (
      <Card data-qa="card-setup-health" size="sm">
        <CardHeader>
          <CardTitle>Setup & health</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Can't reach the doctor API</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => doctor.refetch()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!doctor.data) {
    return (
      <Card data-qa="card-setup-health" size="sm">
        <CardHeader>
          <CardTitle>Setup & health</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  const findings = doctor.data.findings;
  const grouped = groupHealthFindings(findings);

  return (
    <Card data-qa="card-setup-health" size="sm">
      <CardHeader>
        <CardTitle>Setup & health</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <HealthGroup groupId="needs-action" findings={grouped['needs-action']} />
        <HealthGroup groupId="not-configured" findings={grouped['not-configured']} />
        <OkGroup findings={grouped.ok} total={findings.length} />
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate({ name: 'onboarding' })}
        >
          Set up a new profile
        </Button>
      </CardFooter>
    </Card>
  );
}
