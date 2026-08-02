/**
 * E2E fixture data — 10 synthetic jobs for `profiles/rajni`'s local sqlite
 * DB (T11). Every job is built through `JDSchema.parse` so a fixture that
 * drifts from the real schema fails loudly at seed time rather than
 * silently shipping a bad row; the schema is the correctness mechanism,
 * not this file's own judgment.
 */

import type { JD, WorkType } from '../../src/core/jd/index.ts';
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
      verdicts: [],
      score: over.score,
      excitement: undefined,
      matchReasons: ['Strong skill overlap', 'Seniority match'],
    },
  };
  return JDSchema.parse(jd);
}

/** 10 fixtures, ids `rajni-e2e-1`..`rajni-e2e-10`, distinct descending
 * `dateFound` (`rajni-e2e-1` newest — hoursAgo ascending) so the default
 * `sort: 'date_found', order: 'desc'` list is total-ordered. Tracking for
 * 3 of them is added separately in `seed.ts` via `importTracking`. */
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
];
