import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkedInLane } from './lane.ts';
import { RESUME_STATE_PATH, type ResumeStateShape } from './resume_state.ts';
import {
  FakeBrowserProvider,
  FakeStorage,
  fakeCtx,
  fixtureFilterConfig,
  newScript,
  singlePageInventory,
  URL_1,
  URL_2,
} from './testkit/index.ts';

/**
 * Lane-level coverage (2026-08-02 review, restored total-outage
 * loudness) for the identity-invalid card-gate fix in card_gate.ts,
 * driven end to end through `LinkedInLane.source()` rather than the
 * gateCards unit alone — the failure mode this guards was diagnosed from
 * a real run (profiles/harish/data/runs/2026-08-02/18-24/: 13
 * "linkedin lane: url failed" warnings with zod too_small errors on
 * identity.company/identity.title, discarding ~8 URLs' worth of
 * otherwise-healthy cards).
 *
 * The semantic split under test:
 *   - SOME cards on a page identity-invalid, others pass/fail normally
 *     -> per-card drops only, the url stays healthy (the bug fix).
 *   - EVERY harvested card on a page identity-invalid -> the url is
 *     marked failed (same as the pre-fix crash's outcome for that page),
 *     so a systemic paint-storm/selector-drift still drives lane.ts's
 *     failedUrls === attemptedUrls loud throw.
 */

function identityInvalidCard(id: string) {
  return {
    title: '',
    company: 'Bad Co',
    location: 'Remote',
    href: `/jobs/view/${id}/`,
  };
}

test('every url yielding only identity-invalid cards: the lane throws loud (total outage), not a silent empty success', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    identityInvalidCard('9101'),
    identityInvalidCard('9102'),
  ]);
  script.harvestByUrl.set(URL_2, [identityInvalidCard('9201')]);

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  await assert.rejects(
    () => lane.source(fakeCtx()),
    /card\(s\) had empty\/invalid title or company after extraction/,
  );
});

test('one url all-invalid among healthy urls: that url is recorded failed, the run stays fail-soft, and the healthy url s jobs survive', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    identityInvalidCard('9301'),
    identityInvalidCard('9302'),
  ]);
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9401/',
    },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/9401/', 'JD text — Acme FE');

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, dropped } = await lane.source(fakeCtx());

  assert.deepEqual(
    jobs.map((j) => j.identity.id),
    ['li-9401'],
  );
  assert.ok(
    dropped.some(
      (d) =>
        d.jd.identity.id === 'li-9301' &&
        d.reasons.some((v) => v.rule === 'linkedin.cardIdentityInvalid'),
    ),
  );
  assert.ok(
    dropped.some(
      (d) =>
        d.jd.identity.id === 'li-9302' &&
        d.reasons.some((v) => v.rule === 'linkedin.cardIdentityInvalid'),
    ),
  );

  // URL_1 was marked failed internally (not just coincidentally empty):
  // its persisted resume state must NOT be marked done, so a later fire
  // retries it — URL_2, healthy, must be marked done.
  const resume = storage.get(RESUME_STATE_PATH) as ResumeStateShape;
  assert.equal(Object.hasOwn(resume.done, URL_1), false);
  assert.equal(Object.hasOwn(resume.done, URL_2), true);
});

test('a mixed page (one identity-invalid card among otherwise-normal cards): no url failure, a per-card drop is recorded, and the valid card still passes', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/9501/',
    },
    identityInvalidCard('9502'),
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/9501/', 'JD text — Acme FE');

  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, dropped } = await lane.source(fakeCtx());

  assert.deepEqual(
    jobs.map((j) => j.identity.id),
    ['li-9501'],
  );
  const invalidDrop = dropped.find((d) => d.jd.identity.id === 'li-9502');
  assert.ok(invalidDrop, 'the identity-invalid card must still be recorded as a drop');
  assert.equal(invalidDrop?.reasons[0]?.rule, 'linkedin.cardIdentityInvalid');

  // URL_1 stayed healthy: marked done, unlike the all-invalid scenario.
  const resume = storage.get(RESUME_STATE_PATH) as ResumeStateShape;
  assert.equal(Object.hasOwn(resume.done, URL_1), true);
});
