/**
 * The vocabulary module's single import point (R8): every screen that
 * needs a triage-action label, a lane label/icon, or a tracking/excitement
 * vocabulary option imports from here, not from the individual files.
 */

export {
  EXCITEMENT_OPTIONS,
  STATUS_OPTIONS,
} from '../../../../src/core/tracking/vocab.ts';
export { LANE_LABELS, laneIcon, laneLabel } from './lanes.ts';
export { TRIAGE_ACTION_LABELS } from './triageActions.ts';
