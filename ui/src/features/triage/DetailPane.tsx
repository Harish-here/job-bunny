import { Card } from '../../components/ui/card';
import type { BoardJobDetail } from '../../lib/api/types';
import { EligibilityGrid } from '../job/EligibilityGrid';
import { JdText } from '../job/JdText';
import { JobHeader } from '../job/JobHeader';
import { JobSignals } from '../job/JobSignals';
import { SkillsList } from '../job/SkillsList';
import { TrackingPanel } from '../job/TrackingPanel';
import { DecideBar } from './DecideBar';
import type { DecideAction } from './decide';

/**
 * `ux-notes.md` §5 — the triage detail pane (blueprint steps 19–20,
 * ui-design-system task 7). Pure composition: `JobHeader` (which already
 * renders `ArchivedStrip` and `MatchScore` internally, tasks 3–4) →
 * `JobSignals` → `EligibilityGrid` → `SkillsList` → `JdText` → `TrackingPanel`
 * → sticky `DecideBar`, inside one `Card`. Of the five states in
 * `ux-notes.md` §5's states table, loading/empty/error are already handled
 * one level up in `TriagePage.tsx`'s existing conditional branches —
 * `DetailPane` itself only ever renders once a `detail` object exists, so it
 * covers default/decided (success) and sparse (empty-within-populated).
 * `jdExpanded`/`onToggleJdExpanded` are forwarded, not owned — `TriagePage`
 * keeps that state session-sticky across job selections.
 */
export function DetailPane({
  profile,
  detail,
  onDecide,
  jdExpanded,
  onToggleJdExpanded,
}: {
  profile: string;
  detail: BoardJobDetail;
  onDecide: (action: DecideAction) => void;
  jdExpanded: boolean;
  onToggleJdExpanded: () => void;
}) {
  return (
    <Card className="overflow-visible" data-qa="detail-pane">
      <JobHeader job={detail} />
      <JobSignals matchReasons={detail.matchReasons} reviewFlags={detail.reviewFlags} />
      <EligibilityGrid
        locationCity={detail.locationCity}
        workType={detail.workType}
        seniority={detail.seniority}
        timezone={detail.timezone}
      />
      <SkillsList skills={detail.skills} />
      <JdText
        jd={detail.jd}
        url={detail.url}
        expanded={jdExpanded}
        onToggleExpanded={onToggleJdExpanded}
      />
      <TrackingPanel profile={profile} job={detail} />
      <DecideBar job={detail} onDecide={onDecide} />
    </Card>
  );
}
