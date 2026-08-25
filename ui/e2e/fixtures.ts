/**
 * E2E fixture data — synthetic jobs for `profiles/rajni`'s local sqlite DB
 * (T11). Every job is built through `JDSchema.parse` so a fixture that
 * drifts from the real schema fails loudly at seed time rather than
 * silently shipping a bad row; the schema is the correctness mechanism,
 * not this file's own judgment.
 */

import type { JD, Verdict, WorkType } from '../../src/core/jd/index.ts';
import { JDSchema } from '../../src/core/jd/index.ts';

interface JdOverrides {
  id: string;
  title: string;
  company: string;
  hoursAgo: number;
  score: number;
  city?: string;
  workType?: WorkType;
  skills?: string[];
  /** QA round 1 bug 1 — soft-fail verdicts, projected by `reviewFlags()`
   * into the pane's REVIEW FLAGS zone. Defaults to none (`reviewFlags()`
   * hides the whole zone when empty). */
  verdicts?: Verdict[];
  /** QA round 1 bug 2 — the read-only excitement badge
   * (`tracking-excitement`). One of `EXCITEMENT_OPTIONS`; defaults to
   * unset (badge omitted). */
  excitement?: string;
}

const NOW = Date.now();

function scrapedAt(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString();
}

export function makeJd(over: JdOverrides): JD {
  const skills = over.skills ?? ['React', 'TypeScript', 'JavaScript'];
  const city = over.city ?? 'Bengaluru';
  const workType = over.workType ?? 'remote';
  const rawText =
    `${over.title} at ${over.company}.\n\n` +
    `We're hiring a ${over.title} to help build and ship our product. ` +
    `You'll work closely with design and product to own frontend architecture ` +
    `end to end, in a ${workType} setup based out of ${city}.\n\n` +
    `Requirements: strong experience with ${skills.join(', ')}.`;

  const jd = {
    identity: {
      id: over.id,
      lane: 'linkedin',
      url: `https://example.com/jobs/${over.id}`,
      company: over.company,
      title: over.title,
      scrapedAt: scrapedAt(over.hoursAgo),
      location: city,
    },
    content: { rawText },
    structured: {
      titleParts: { domain: 'frontend', seniority: 'Staff', func: 'engineering' },
      locations: [{ city, country: 'India' }],
      workType,
      timezone: 'APAC',
      skills,
    },
    evaluation: {
      verdicts: over.verdicts ?? [],
      score: over.score,
      excitement: over.excitement,
      matchReasons: ['Strong skill overlap', 'Seniority match'],
    },
  };
  return JDSchema.parse(jd);
}

/** 10 populated fixtures (`rajni-e2e-1`..`rajni-e2e-10`), 1 sparse fixture
 * (`rajni-e2e-11`), and 1 archived fixture (`rajni-e2e-12`, QA round 1 bug
 * 2) — 12 rows total, distinct descending `dateFound` (`rajni-e2e-1`
 * newest — hoursAgo ascending) so the default `sort: 'date_found', order:
 * 'desc'` list is total-ordered. Tracking for 3 of them is added
 * separately in `seed.ts` via `importTracking`; `rajni-e2e-12`'s archived
 * flag is likewise set separately in `seed.ts` via `markArchived` — the
 * JD schema itself carries no `archived` field, it's a store-level column.
 * `rajni-e2e-12` is a NEW 12th fixture rather than marking an existing one
 * archived: every default query (`TriagePage`'s `DEFAULT_QUERY`,
 * `TrackerPage`'s `QUERY`) excludes archived jobs, so archiving one of the
 * 11 already-counted-on rows would silently drop the default triage list's
 * count from 11 to 10 and break `smoke.spec.ts`'s literal `toHaveCount(11)`
 * assertions; a new, always-hidden-by-default 12th row leaves every
 * existing count assertion untouched. `rajni-e2e-6` additionally carries 2
 * soft-fail verdicts (QA round 1 bug 1 — `reviewFlags`), an excitement
 * level, and 10 skills (QA round 1 bug 2 — `skills-more`, `>8`). */
export const FIXTURE_JOBS: JD[] = [
  makeJd({
    id: 'rajni-e2e-1',
    title: 'Staff Frontend Engineer',
    company: 'AlphaCo',
    hoursAgo: 0,
    score: 95,
    workType: 'remote',
    city: 'Bengaluru',
  }),
  makeJd({
    id: 'rajni-e2e-2',
    title: 'Lead UI Engineer',
    company: 'BravoWorks',
    hoursAgo: 1,
    score: 90,
    workType: 'hybrid',
    city: 'Chennai',
  }),
  makeJd({
    id: 'rajni-e2e-3',
    title: 'Senior React Engineer',
    company: 'Cognivue',
    hoursAgo: 2,
    score: 85,
    workType: 'remote',
    city: 'Bengaluru',
  }),
  makeJd({
    id: 'rajni-e2e-4',
    title: 'Staff Platform Engineer',
    company: 'DeltaForge',
    hoursAgo: 3,
    score: 80,
    workType: 'onsite',
    city: 'Chennai',
  }),
  makeJd({
    id: 'rajni-e2e-5',
    title: 'Lead Design Systems Engineer',
    company: 'Emberlytics',
    hoursAgo: 4,
    score: 75,
  }),
  makeJd({
    id: 'rajni-e2e-6',
    title: 'Senior Frontend Architect',
    company: 'Fenwick Labs',
    hoursAgo: 5,
    score: 70,
    skills: [
      'React',
      'TypeScript',
      'JavaScript',
      'Node.js',
      'GraphQL',
      'CSS',
      'HTML',
      'Webpack',
      'Jest',
      'Redux',
    ],
    excitement: 'Vera level',
    verdicts: [
      {
        rule: 'salary_below_min',
        severity: 'soft',
        pass: false,
        detail: 'Salary range not listed',
      },
      {
        rule: 'stale_posting',
        severity: 'soft',
        pass: false,
        detail: 'Posted over 30 days ago',
      },
    ],
  }),
  makeJd({
    id: 'rajni-e2e-7',
    title: 'Staff Web Engineer',
    company: 'Glimmertech',
    hoursAgo: 6,
    score: 65,
  }),
  makeJd({
    id: 'rajni-e2e-8',
    title: 'Lead JavaScript Engineer',
    company: 'Hedgemont',
    hoursAgo: 7,
    score: 60,
  }),
  makeJd({
    id: 'rajni-e2e-9',
    title: 'Senior UI Platform Engineer',
    company: 'Ironclad Systems',
    hoursAgo: 8,
    score: 55,
  }),
  makeJd({
    id: 'rajni-e2e-10',
    title: 'Staff React Developer',
    company: 'Junoscape',
    hoursAgo: 9,
    score: 50,
  }),
  // The sparse fixture (S7 `detail-sparse`) — built via `JDSchema.parse`
  // directly, bypassing `makeJd()`, since `content`/`structured`/
  // `evaluation` must all be omitted to match the mockup's
  // empty-within-populated frame (score: null, matchReasons: [],
  // skills: [], workType/seniority/timezone: null, jd.content: undefined).
  // `hoursAgo: 10` keeps it oldest, appended last, so no other fixture's
  // relative order shifts.
  JDSchema.parse({
    identity: {
      id: 'rajni-e2e-11',
      lane: 'greenhouse',
      url: 'https://example.com/jobs/rajni-e2e-11',
      company: 'Nimbus Works',
      title: 'Backend Engineer (Contract)',
      scrapedAt: scrapedAt(10),
      location: 'Remote',
    },
  }),
  // QA round 1 bug 2 (S6 `detail-archived`) — a normal, fully-populated
  // fixture; `seed.ts` marks it archived via `store.markArchived()` after
  // insert. `hoursAgo: 11` keeps it the oldest of all 12, appended last, so
  // no other fixture's relative order shifts.
  makeJd({
    id: 'rajni-e2e-12',
    title: 'Platform Reliability Engineer',
    company: 'Kestrel Systems',
    hoursAgo: 11,
    score: 68,
  }),
];
