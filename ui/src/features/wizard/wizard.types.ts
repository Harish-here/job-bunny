export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
export type WorkType = 'onsite' | 'hybrid' | 'remote';
export type SchedulePreset = 'morning' | 'morning-afternoon' | 'custom' | 'manual';

export interface WizardLocation {
  city: string;
  country: string;
}

export interface SearchUrlEntry {
  label: string;
  url: string;
}

export interface AboutAnswers {
  seniority: string[]; // display-cased, e.g. ['Staff', 'Lead']
  yoe: number | null;
  coreSkills: string[];
  secondarySkills: string[];
  domainExperience: string[];
  workTypes: WorkType[];
  locations: WizardLocation[]; // index 0 is home; later entries are also acceptable
}

export interface HuntAnswers {
  urls: SearchUrlEntry[];
}

export interface ExtrasAnswers {
  notionDbId: string;
  notionMirror: boolean;
  notionTokenSaved: boolean; // never the token itself
  telegramChatId: string; // raw input; parsed to a number on write
  telegramTokenSaved: boolean; // never the token itself
}

export interface LaunchAnswers {
  preset: SchedulePreset;
  customTimes: string[]; // 'HH:MM'
  weekdays: number[]; // 0=Sun … 6=Sat
}

export interface WizardDraft {
  version: 1;
  profile: string;
  step: WizardStep;
  personaId: string | null;
  about: AboutAnswers;
  hunt: HuntAnswers;
  extras: ExtrasAnswers;
  launch: LaunchAnswers;
  /** True once THIS session's Step3About submit has already written
   * resume.json + filter.json for `profile` — set right after that write
   * succeeds, never re-derived from the documents themselves. Lets the
   * never-clobber guard tell "my own prior write" (skip the guard, so Back
   * then Next again can re-submit) apart from "real pre-existing config"
   * (keep blocking), instead of tripping on either one identically. */
  wroteAbout: boolean;
  /** Same idea as `wroteAbout`, for Step4Hunt's search_urls.md write. */
  wroteHunt: boolean;
}

/** The props every wizard step component receives. `WizardPage` owns all
 *  chrome (the step wrapper, the single error alert, and both footer
 *  buttons); a step renders only its own fields. `onDraftChange` fires on
 *  every field edit — never only on Next — which is what makes "Back never
 *  loses input" true. A step registers its save handler through
 *  `registerSubmit` from a `useEffect`, and registers `null` on unmount;
 *  `WizardPage`'s Next button calls it and advances only when it resolves
 *  `true`. Step 5 additionally receives `onSkip: () => void`. */
export interface WizardStepProps {
  draft: WizardDraft;
  onDraftChange: (next: WizardDraft) => void;
  registerSubmit: (handler: (() => Promise<boolean>) | null) => void;
}

/**
 * Seeds a fresh draft for a profile that step 1 has already created on the
 * server. `step: 2` is deliberate, not a default-to-zero placeholder: a
 * draft only ever exists once step 1 has succeeded, so the first resumable
 * step for a brand-new draft is always 2, never 1.
 */
export function emptyDraft(profile: string): WizardDraft {
  return {
    version: 1,
    profile,
    step: 2,
    personaId: null,
    about: {
      seniority: [],
      yoe: null,
      coreSkills: [],
      secondarySkills: [],
      domainExperience: [],
      workTypes: [],
      locations: [],
    },
    hunt: { urls: [] },
    extras: {
      notionDbId: '',
      notionMirror: false,
      notionTokenSaved: false,
      telegramChatId: '',
      telegramTokenSaved: false,
    },
    launch: {
      preset: 'morning',
      customTimes: [],
      weekdays: [1, 2, 3, 4, 5],
    },
    wroteAbout: false,
    wroteHunt: false,
  };
}

export interface PersonaRule {
  match: string[];
  reject: string[];
}

export interface Persona {
  id: string;
  label: string;
  blurb: string;
  coreSkills: string[];
  secondarySkills: string[];
  seniorityOptions: string[];
  title: { domain: PersonaRule; function: PersonaRule };
}

export interface PersonaCatalog {
  version: number;
  personas: Persona[];
}

export type DaemonState = 'running' | 'stopped' | 'stale';

export interface DaemonProfileSchedule {
  profile: string;
  enabled: boolean;
  nextRunAt: string | null;
}

export interface DaemonStatus {
  state: DaemonState;
  pid: number | null;
  startedAt: string | null;
  lastTickAt: string | null;
  inFlight: { profile: string; pid: number; startedAt: string } | null;
  profiles: DaemonProfileSchedule[];
}

export interface RunIntentView {
  id: number;
  requestedAt: string;
  status: 'pending' | 'claimed' | 'cancelled' | 'expired';
  claimedRunId: number | null;
}
