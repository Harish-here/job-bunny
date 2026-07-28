import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { LinkedinBreakerDeps } from './breaker_store.ts';
import { CAPTURE_PATH } from './capture_store.ts';
import { LinkedInLane } from './lane.ts';
import { jitterMs } from './pacing/index.ts';
import { RESUME_STATE_PATH } from './resume_state.ts';
import { parseSearchUrls } from './search_urls.ts';
import {
  BREAKER_DIR,
  FakeBrowserProvider,
  FakeStorage,
  fakeBreakerFs,
  fakeCapturedJD,
  fakeCtx,
  fixtureFilterConfig,
  NOW,
  newScript,
  noopLogger,
  OPENED_LONG_AGO,
  OPENED_RECENTLY,
  REPO_ROOT,
  seedHappyPathScript,
  seedTrivialUrl,
  singlePageInventory,
  spySleepFn,
  URL_1,
  URL_2,
  URL_3,
} from './testkit/index.ts';

test('happy path: 2 urls, some cards gated out, surviving JDs opened, companiesSeen deduped, beat() ticked', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  let beats = 0;
  const ctx = fakeCtx({
    beat() {
      beats += 1;
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, dropped, companiesSeen } = await lane.source(ctx);

  assert.equal(jobs.length, 4);
  for (const jd of jobs) {
    assert.equal(jd.identity.lane, 'linkedin');
    assert.ok(jd.content?.rawText);
    // Every seeded card carries location: 'Remote' — it must land on
    // identity.location, not just live on the harvested card.
    assert.equal(jd.identity.location, 'Remote');
  }
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);

  // Bad Co (li-1002) was gated out by the card-gate — its DroppedRecord
  // must flow through source(), not be silently discarded (finding 5).
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.jd.identity.id, 'li-1002');
  assert.equal(dropped[0]?.jd.identity.company, 'Bad Co');
  assert.ok(
    dropped[0]?.reasons.some((v) => v.rule === 'company.avoid' && v.pass === false),
  );

  assert.deepEqual([...companiesSeen].sort(), ['Acme', 'Globex', 'Initech']);
  assert.ok(beats >= 4);
});

test("one url's goto/harvest throws: logged and skipped, the other url is still processed, source() does not throw (partial failure isn't aggregate failure)", async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-2001', 'li-2002']);
  const urlFailedWarning = warnings.find(
    (w) => (w as { msg: string }).msg === 'linkedin lane: url failed',
  ) as { data: { message: string } } | undefined;
  assert.ok(urlFailedWarning);
  assert.match(urlFailedWarning.data.message, /goto failed/);

  // markDone must NOT have been called for the failed url — only url2 is
  // in the persisted done-map (finding 2b).
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.equal(Object.hasOwn(persisted.done, URL_1), false);
  assert.equal(Object.hasOwn(persisted.done, URL_2), true);
});

test("one card's openJd throws (empty text): that card is skipped, other cards in the same url are still captured", async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1001/'); // Acme in url1 fails to open
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, dropped, companiesSeen } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1003', 'li-2001', 'li-2002']);
  // companiesSeen is recorded at the card-gate step, before JD open —
  // Acme still counts as "seen" even though its JD open failed.
  assert.deepEqual([...companiesSeen].sort(), ['Acme', 'Globex', 'Initech']);

  // The url itself succeeded (only one card within it failed) — it must
  // still be marked done, unlike a whole-url failure.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.ok(Object.hasOwn(persisted.done, URL_1));

  // The failed card's JD-open still shows up as a DroppedRecord, not just
  // a warn — the funnel must always be able to answer "why did this
  // disappear?".
  const acmeDrop = dropped.find((d) => d.jd.identity.id === 'li-1001');
  assert.ok(acmeDrop, 'the failed-to-open Acme card must appear in dropped');
  assert.ok(
    acmeDrop?.reasons.some((r) => r.rule === 'linkedin.jdOpenFailed' && r.pass === false),
  );
});

test('every card JD-open failing for a url leaves it un-marked-done (resumable) and does not throw when another url still succeeds', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  // Delete BOTH surviving cards' jd text for url1 (Acme li-1001, Globex
  // li-1003) so every card that passed the card-gate still fails to open —
  // url2 is untouched and still succeeds normally.
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1001/');
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1003/');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, dropped } = await lane.source(ctx);

  // url2's jobs still come through — this is not treated as an aggregate
  // failure since url2 succeeded.
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-2001', 'li-2002']);

  // Both of url1's cards appear as DroppedRecords.
  const url1DropIds = dropped
    .filter((d) => d.reasons.some((r) => r.rule === 'linkedin.jdOpenFailed'))
    .map((d) => d.jd.identity.id)
    .sort();
  assert.deepEqual(url1DropIds, ['li-1001', 'li-1003']);

  // url1 must NOT be marked done — a run where every JD-open failed for a
  // url must be retried next fire, not skipped as if it were healthy.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.equal(Object.hasOwn(persisted.done, URL_1), false);
  assert.ok(Object.hasOwn(persisted.done, URL_2));

  assert.ok(
    warnings.some(
      (w) =>
        (w as { msg: string }).msg === 'linkedin lane: every card JD-open failed for url',
    ),
  );
});

test('lane-wide "no JD ever opened" guard: url A attempts 2 cards and fails both, url B has zero cards survive gating — not every url is marked failed, but the lane still throws (2026-07-25 incident)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  // url1: both surviving cards (Acme li-1001, Globex li-1003) fail to open.
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1001/');
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1003/');
  // url2: its one card is entirely gated out (avoid-listed company), so
  // cardsAttempted === 0 for url2 — it can never be marked a failedUrl by
  // the per-url guard, which is exactly what let this incident slip past
  // the old attemptedUrls/failedUrls check.
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Staff Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/2001/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  await assert.rejects(
    () => lane.source(ctx),
    (err: Error) => {
      assert.match(err.message, /2 card\(s\) were attempted across 2 url\(s\)/);
      assert.match(err.message, /zero JDs were captured/);
      assert.match(err.message, /jd_open\.ts/);
      assert.match(err.message, /jdRoot/);
      return true;
    },
  );
});

test('lane-wide "no JD ever opened" guard preserves prior same-day captures instead of throwing them away (review finding 4)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  // Same shape as the 2026-07-25 incident test above: url1's surviving
  // cards both fail to open, url2's card is entirely gated out. But this
  // fire follows an earlier same-day fire that already flushed a capture —
  // throwing here would discard that real work.
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1001/');
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1003/');
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/2001/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  storage.set(CAPTURE_PATH, [fakeCapturedJD('li-9001', 'EarlierCo')]);
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);
  assert.deepEqual(
    jobs.map((jd) => jd.identity.id),
    ['li-9001'],
    "the prior fire's capture must survive this fire's JD-open outage",
  );
  assert.ok(
    warnings.some((w) => /every JD-open failed/.test((w as { msg: string }).msg)),
    'the outage must still be surfaced loudly in the log',
  );
});

test('lane-wide "no JD ever opened" guard does not fire when nothing survives title-gating anywhere (legitimate empty result)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Every card on every url is avoid-listed — a clean "nothing to
  // capture" run, not an outage.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/1001/',
    },
  ]);
  script.harvestByUrl.set(URL_2, [
    {
      title: 'Staff Engineer',
      company: 'Bad Co',
      location: 'Remote',
      href: '/jobs/view/2001/',
    },
  ]);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs, dropped } = await lane.source(ctx);
  assert.deepEqual(jobs, []);
  assert.ok(dropped.length >= 2);
});

test('lane-wide "no JD ever opened" guard does not fire when at least one JD-open succeeds somewhere', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  // url1's cards both fail to open; url2 is untouched and still succeeds.
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1001/');
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1003/');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-2001', 'li-2002']);
});

test('anchor-fallback extractions are counted and surfaced as one lane-level warning (review finding 7)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  for (const url of script.jdTextByUrl.keys()) script.anchorOnlyUrls.add(url);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);
  assert.equal(jobs.length, 4, 'anchor-fallback extraction must still capture JDs');
  const anchorWarning = warnings.find((w) => /anchor/.test((w as { msg: string }).msg)) as
    | { data?: { anchorExtractions?: number } }
    | undefined;
  assert.ok(anchorWarning, 'expected a lane-level anchor-fallback warning');
  assert.equal(anchorWarning?.data?.anchorExtractions, 4);
});

test('resume: a url already marked done in ResumeState is skipped entirely — its page is never opened', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 2 } });
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-2001', 'li-2002']);
  assert.equal(provider.handle?.pages.length, 1); // only url2's page was ever opened
});

test('resume: captures already flushed by an earlier fire today are reloaded, so a skipped (already-done) url still contributes its jobs (finding 2c)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 2 } });
  // url1's jobs from the earlier fire, already durably flushed.
  storage.set(CAPTURE_PATH, [
    fakeCapturedJD('li-1001', 'Acme'),
    fakeCapturedJD('li-1003', 'Globex'),
  ]);
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  // url1 is skipped (page never opened) but its previously-flushed
  // captures still surface, alongside url2's freshly harvested jobs.
  assert.equal(provider.handle?.pages.length, 1);
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);
});

test('same-day second fire: when ResumeState already has ALL urls marked done, source() rescan-resets and re-opens/harvests every url instead of skipping them, and clears stale captures (finding 2)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 3, [URL_2]: 2 } });
  // A stale ghost from the earlier fire(s) today, no longer part of any
  // card this run harvests — rescanReset's capture-file clear must drop
  // it, or it would linger forever.
  storage.set(CAPTURE_PATH, [fakeCapturedJD('li-9999', 'GhostCo')]);
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  // Both urls' pages were opened (not skipped) and jobs came back from both.
  assert.equal(provider.handle?.pages.length, 2);
  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1001', 'li-1003', 'li-2001', 'li-2002']);
  assert.ok(!ids.includes('li-9999'));
});

test('browser.launch throwing is a loud lane failure: source() rejects', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  const provider = new FakeBrowserProvider(script, true);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
  );

  await assert.rejects(() => lane.source(ctx), /Chrome would not launch/);
});

test('every attempted url failing is a loud aggregate failure (finding 3) — goto failures report as "other reasons", NOT an asserted expired session', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  script.gotoThrows.add(URL_2);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  // The guard must still throw loud (do NOT weaken it) — but a plain goto
  // failure is neither "zero cards in the DOM" nor "field validation
  // failed"; it must land in the evidence-based "other reasons" bucket and
  // must NOT assert a confident "expired session" cause.
  await assert.rejects(
    () => lane.source(ctx),
    /all 2 attempted url\(s\) failed this run.*url\(s\) failed for other reasons.*goto failed/s,
  );
  await assert.rejects(
    () => lane.source(ctx),
    (err: Error) => {
      assert.doesNotMatch(err.message, /expired LinkedIn session/);
      return true;
    },
  );
});

test('every attempted url failing with zero cards harvested reports a DOM/authwall-shaped message, distinct from field-validation failures', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // No cards scripted for either url at all — harvestCards' own min-count
  // guard (harvest.ts) throws "... is below min N ...", the genuine
  // zero-cards-in-the-DOM signal.
  script.harvestByUrl.set(URL_1, []);
  script.harvestByUrl.set(URL_2, []);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  let message = '';
  await assert.rejects(
    () => lane.source(ctx),
    (err: Error) => {
      message = err.message;
      return true;
    },
  );
  assert.match(message, /zero \(or too few\) cards in the DOM/);
  assert.match(message, /is below min/);
  assert.match(message, /authwall\/logout wall/);
  assert.match(message, /\.chrome-debug\//);
  // This case legitimately implicates the session, so it MAY mention it —
  // but only as one candidate among others, not an outright assertion.
  assert.doesNotMatch(message, /had empty\/invalid title or company/);
});

test('every attempted url failing with cards found but empty title/company reports a field-extraction message and does NOT claim the session expired', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Cards ARE found in the DOM and the JD pane DOES open with real text —
  // but title/company extracted as empty strings, so JDSchema.parse's Zod
  // `too_small` on identity.company/title fires in the per-card capture
  // path (lane.ts, after openJd succeeds), NOT because the JD-open itself
  // failed. This is the 2026-07-25 real incident this defect was filed
  // against: an empty-fields problem, not a session or JD-open problem.
  script.harvestByUrl.set(URL_1, [
    { title: '', company: '', location: 'Remote', href: '/jobs/view/9001/' },
  ]);
  script.harvestByUrl.set(URL_2, [
    { title: '', company: '', location: 'Remote', href: '/jobs/view/9002/' },
  ]);
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/9001/', 'JD text — 9001');
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/9002/', 'JD text — 9002');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  let message = '';
  await assert.rejects(
    () => lane.source(ctx),
    (err: Error) => {
      message = err.message;
      return true;
    },
  );
  assert.match(message, /had empty\/invalid title or company after extraction/);
  assert.match(message, /cards WERE found in the DOM/);
  assert.match(
    message,
    /src\/adapters\/lanes\/linkedin\/page_inventory\/linkedin__jobs-search\.json/,
  );
  // D13: the message may name drifted sub-selectors as A candidate, but it
  // must no longer ASSERT that the session is fine — that claim sent the
  // 2026-07-28 throttle investigation to /page-analyse for two days.
  assert.doesNotMatch(message, /NOT a session problem/);
  assert.match(message, /one candidate/i);
  // The defining assertion for this defect: an empty-fields failure must
  // never claim the session expired, and must not even land in the
  // zero-cards bucket (cards WERE found).
  assert.doesNotMatch(message, /expired LinkedIn session/);
  assert.doesNotMatch(message, /zero \(or too few\) cards in the DOM/);
});

test('zero attempted urls (empty url list) does not trip the aggregate-failure check', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(provider, [inv], [], fixtureFilterConfig(), storage);

  const { jobs } = await lane.source(ctx);
  assert.deepEqual(jobs, []);
});

test("newPage() throwing (dead CDP context) is this url's SoftError alone, not a whole-lane failure (finding 4)", async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  // url1 is the first newPage() call (index 0); url2 is the second (index 1).
  const provider = new FakeBrowserProvider(script, false, new Set([0]));
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-2001', 'li-2002']);
  const urlFailedWarning = warnings.find(
    (w) => (w as { msg: string }).msg === 'linkedin lane: url failed',
  ) as { data: { message: string } } | undefined;
  assert.ok(urlFailedWarning);
  assert.match(urlFailedWarning.data.message, /newPage failed/);
});

test('resumeState.persist is called after EVERY url (success or failure), not once at the end (finding 2a)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  await lane.source(ctx);

  const resumeWrites = storage.writes.filter((path) => path === RESUME_STATE_PATH);
  // One persist after url1 (failed) and one after url2 (succeeded) — not
  // a single write at the very end, which would lose url1's outcome (and
  // url2's, if the crash happened before that single end-of-run write).
  assert.equal(resumeWrites.length, 2);
});

test('captured JDs are flushed incrementally (per-JD), not batched at end-of-run (finding 2c)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  await lane.source(ctx);

  // 4 jobs are captured across both urls in the happy-path script — each
  // must have triggered its own persist to CAPTURE_PATH.
  const captureWrites = storage.writes.filter((path) => path === CAPTURE_PATH);
  assert.equal(captureWrites.length, 4);
});

test('handle.close() is always called, including when a url fails, and every opened page is closed', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  await lane.source(ctx);

  assert.equal(provider.handle?.closed, true);
  assert.ok(provider.handle);
  for (const page of provider.handle?.pages ?? []) {
    assert.equal(page.closed, true);
  }
});

test('a url group with no matching inventory is logged and skipped, not thrown', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv], // only has 'linkedin__jobs-search' — 'unknown-page' has none
    [{ page: 'unknown-page', urls: ['https://www.linkedin.com/jobs/search/?x=1'] }],
    fixtureFilterConfig(),
    storage,
  );

  const { jobs } = await lane.source(ctx);

  assert.deepEqual(jobs, []);
  const groupWarning = warnings.find(
    (w) => (w as { msg: string }).msg === 'linkedin lane: no inventory found for page',
  ) as { data: { page: string } } | undefined;
  assert.ok(groupWarning);
  assert.equal(groupWarning.data.page, 'unknown-page');
});
// ---------- jitter (P9 tail: v0->v2 parity regression fix) ----------

test('jitterMs: rand=0 returns exactly minMs (inclusive lower bound)', () => {
  assert.equal(
    jitterMs(2_000, 5_000, () => 0),
    2_000,
  );
});

test('jitterMs: rand=~1 returns just under maxMs (exclusive upper bound), never maxMs itself', () => {
  const result = jitterMs(2_000, 5_000, () => 0.999_999);
  assert.ok(result < 5_000);
  assert.ok(result >= 2_000);
});

test('jitterMs: rand=0.5 returns the midpoint of the range', () => {
  assert.equal(
    jitterMs(2_000, 5_000, () => 0.5),
    2_000 + Math.floor(0.5 * 3_000),
  );
});

test('jitter: applied once before every JD open (card loop) and once per attempted url (url loop), never a real multi-second wait', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined, // maxCardsPerUrl: default
    1_234, // jitterMinMs
    4_321, // jitterMaxMs
    () => 0.5, // randomFn: deterministic midpoint
    spySleepFn(sleepCalls),
  );

  const start = Date.now();
  const { jobs } = await lane.source(fakeCtx());
  const elapsedMs = Date.now() - start;

  // Happy-path fixture: 2 urls attempted (1 jitter each) + 4 cards opened
  // (1 jitter each, li-1001/1003/2001/2002 — li-1002 was gated out before
  // ever reaching the jitter/JD-open step) = 6 total.
  assert.equal(jobs.length, 4);
  assert.equal(sleepCalls.length, 6);
  for (const ms of sleepCalls) {
    assert.equal(ms, 1_234 + Math.floor(0.5 * (4_321 - 1_234)));
  }
  // The spy never actually sleeps — a real 2-5s-per-call implementation
  // would take seconds here; this must stay well under that.
  assert.ok(elapsedMs < 500, `expected a fake-sleep run to be fast, took ${elapsedMs}ms`);
});

test('jitter: a zero-length range (jitterMinMs === jitterMaxMs === 0) is a no-op — the sleepFn is never called', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('jitter: an already-aborted ctx.signal makes the (real, default) jitter reject immediately — the run fails fast rather than hanging for seconds', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  // No injected sleepFn here — deliberately exercising the REAL default
  // (core/async's abort-aware sleep) to prove an already-aborted signal
  // short-circuits without ever starting its 2-5s timer. A real (nonzero)
  // jitter range is passed explicitly since the class's own default is a
  // no-op (see DEFAULT_JITTER_MIN_MS's doc comment) — production's real
  // v0-parity default lives in cli/wire.ts's resolveJitterRange instead.
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    2_000,
    5_000,
  );

  const controller = new AbortController();
  controller.abort(new Error('run cancelled'));
  const ctx = fakeCtx({ signal: controller.signal });

  const start = Date.now();
  // Every url's first jitter call rejects immediately (aborted signal) ->
  // every attempted url fails -> aggregate all-urls-failed throw. The
  // assertion that matters is the timing: this must not take anywhere
  // near the 2-5s-per-url the real jitter range would imply if it didn't
  // honor the abort.
  await assert.rejects(() => lane.source(ctx), /all 2 attempted url\(s\) failed/);
  assert.ok(
    Date.now() - start < 1_000,
    'an aborted signal must not sit in the jitter sleep',
  );
});
// ---------- inter-url pacing (throttle guard D2, 2026-07-28) ----------

test('inter-url pause: 3 attempted urls produce exactly 2 pauses, each the configured midpoint', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3001');
  seedTrivialUrl(script, URL_2, '3002');
  seedTrivialUrl(script, URL_3, '3003');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2, URL_3] }],
    fixtureFilterConfig(),
    storage,
    undefined, // maxCardsPerUrl: default
    0, // jitterMinMs — jitter OFF, so every recorded sleep is an inter-url pause
    0, // jitterMaxMs
    () => 0.5, // randomFn: deterministic midpoint
    spySleepFn(sleepCalls),
    20_000, // interUrlDelayMinMs
    45_000, // interUrlDelayMaxMs
  );

  await lane.source(fakeCtx());

  // Never before the first url, never after the last: N - 1 pauses.
  assert.equal(sleepCalls.length, 2);
  for (const ms of sleepCalls) {
    assert.equal(ms, 20_000 + Math.floor(0.5 * (45_000 - 20_000)));
    assert.ok(ms >= 20_000 && ms < 45_000);
  }
});

test('inter-url pause: a single url produces zero pauses', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3101');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('inter-url pause: a zero-length range is a no-op — the sleepFn is never called', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3201');
  seedTrivialUrl(script, URL_2, '3202');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    0, // interUrlDelayMinMs
    0, // interUrlDelayMaxMs
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 0);
});

test('inter-url pause: a url skipped as already-done costs no pause — only attempted urls are paced', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3301');
  seedTrivialUrl(script, URL_2, '3302');
  seedTrivialUrl(script, URL_3, '3303');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  // The MIDDLE url was already captured by an earlier fire today, so this
  // fire attempts URL_1 and URL_3 only — 2 attempts, 1 pause between them.
  storage.set(RESUME_STATE_PATH, { date: today, done: { [URL_2]: 1 } });
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2, URL_3] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 1);
});

test('inter-url pause: pauses between urls that live in DIFFERENT page groups too', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedTrivialUrl(script, URL_1, '3401');
  seedTrivialUrl(script, URL_2, '3402');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    // Two groups of one url each, both resolving to the same inventory.
    [
      { page: inv.page, urls: [URL_1] },
      { page: inv.page, urls: [URL_2] },
    ],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
  );

  await lane.source(fakeCtx());

  assert.equal(sleepCalls.length, 1);
});

// ---------- parseSearchUrls ----------

test('parseSearchUrls parses the rajni search_urls.md fixture into page groups with their urls', async () => {
  const md = await readFile(`${REPO_ROOT}profiles/rajni/search_urls.md`, 'utf8');
  const groups = parseSearchUrls(md);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.page, 'linkedin__jobs-search');
  assert.deepEqual(groups[0]?.urls, [
    'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R',
    'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400&sortBy=R',
  ]);
});

test('parseSearchUrls drops a page heading with zero urls beneath it', () => {
  const md = [
    '## linkedin',
    '### empty-page',
    '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/empty-page.md -->',
    '',
    '### linkedin__jobs-search',
    '  • Some Search - https://www.linkedin.com/jobs/search/?keywords=X',
  ].join('\n');

  const groups = parseSearchUrls(md);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.page, 'linkedin__jobs-search');
  assert.deepEqual(groups[0]?.urls, ['https://www.linkedin.com/jobs/search/?keywords=X']);
});

test('open breaker: the lane returns skipped with a reopen time and NEVER launches the browser (D9)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_RECENTLY, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.deepEqual(result.jobs, []);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.companiesSeen, []);
  assert.match(result.skipped?.reason ?? '', /throttle cooldown until/);
  // openedAt 11:00 + 4h cooldown = 15:00.
  assert.match(result.skipped?.reason ?? '', /2026-07-28T15:00:00\.000Z/);
  // The defining assertion of D9: a blocked fire leaves zero footprint.
  assert.equal(provider.handle, null);
  // And it changed nothing on "disk".
  assert.deepEqual(fs.writes, []);
  assert.deepEqual(fs.unlinks, []);
});

test('corrupt breaker state: the lane warns that the guard is disabled this fire and farms normally (spec §5 row 1)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);
  // A file that exists but holds garbage — the case that used to disable
  // the whole guard with nothing in the log to show for it.
  const deps: LinkedinBreakerDeps = {
    ...fs.deps,
    existsSync: () => true,
    readFileSync: () => '{not json',
  };
  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: {
      ...noopLogger,
      warn(msg, data) {
        warnings.push({ msg, data });
      },
    },
  });

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps },
  );

  const result = await lane.source(ctx);

  const warned = warnings.find((w) =>
    (w as { msg: string }).msg.includes('breaker state unreadable'),
  ) as { data: { detail: string } } | undefined;
  assert.ok(warned, 'a silently-disabled guard must announce itself');
  assert.match(warned.data.detail, /jobbunny-linkedin-breaker\.json/);
  // Unreadable reads as CLOSED, never as blocked (D12): the fire runs in
  // full rather than being skipped by a file nobody can parse.
  assert.equal(result.skipped, undefined);
  assert.equal(result.jobs.length, 4);
});

test('half-open: a probe returning real text deletes the breaker file and the fire proceeds normally', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.equal(result.skipped, undefined);
  assert.equal(fs.current(), undefined, 'breaker file must be deleted on recovery');
  assert.equal(fs.unlinks.length, 1);
  // The whole fire ran: the happy-path fixture's 4 JD-opens all landed.
  assert.equal(result.jobs.length, 4);
});

test('half-open: after a successful probe the first main-loop url is paced like any other (the probe already spent a request on it)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);
  const sleepCalls: number[] = [];

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0, // jitter off, so sleepCalls records inter-url pauses only
    0,
    () => 0.5,
    spySleepFn(sleepCalls),
    20_000,
    45_000,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.equal(result.skipped, undefined);
  // Three navigations happen this fire — probe(URL_1), URL_1, URL_2 — and
  // the probe is deliberately unpaced, so a pause must precede BOTH
  // main-loop urls. Without the probe marking the fire as started, URL_1
  // would follow the probe's own request to the same url instantly, which
  // is the one moment (recovery from a block) that burst looks worst.
  assert.equal(sleepCalls.length, 2);
  for (const ms of sleepCalls) {
    assert.equal(ms, 20_000 + Math.floor(0.5 * (45_000 - 20_000)));
  }
});

test('half-open: a probe returning a shell re-opens the breaker and ends the fire after ONE JD-open', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1's single card harvests fine, but its JD is a shell: no text
  // scripted, and jdRoot IS present.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/5001/',
    },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/5001/');
  seedTrivialUrl(script, URL_2, '5002');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.match(result.skipped?.reason ?? '', /still throttled/);
  assert.deepEqual(result.jobs, []);
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString(), 'openedAt must be rewritten');
  assert.equal(state?.tripCount, 2);
  // ~2 requests spent: exactly one page was opened, and URL_2 was never
  // visited.
  assert.equal(provider.handle?.pages.length, 1);
  const gotos = provider.handle?.pages[0]?.gotoCalls ?? [];
  assert.equal(gotos.includes(URL_2), false);
});

test('half-open: a probe that THROWS leaves the breaker open with openedAt unchanged (spec §5)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // The probe url's navigation fails outright — inconclusive, not proof
  // that the block cleared.
  script.gotoThrows.add(URL_1);
  seedTrivialUrl(script, URL_2, '5102');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(OPENED_LONG_AGO, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.match(result.skipped?.reason ?? '', /probe inconclusive/);
  const state = fs.current();
  assert.equal(state?.openedAt, OPENED_LONG_AGO.openedAt, 'openedAt must NOT move');
  assert.equal(state?.tripCount, 1, 'an inconclusive probe is not a trip');
  assert.equal(state?.lastProbeAt, NOW.toISOString());
  assert.deepEqual(fs.unlinks, [], 'a broken page must never close the breaker');
});

test('trip: 3 consecutive shells mid-fire open the breaker, stop the remaining urls, and KEEP prior captures (D6)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // URL_1: card 1 captures real text, cards 2-4 are shells. The third
  // shell trips the counter.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6002/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6003/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Umbrella',
      location: 'Remote',
      href: '/jobs/view/6004/',
    },
  ]);
  script.jdTextByUrl.set(
    'https://www.linkedin.com/jobs/view/6001/',
    'JD text — real, captured before the block',
  );
  for (const id of ['6002', '6003', '6004']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6100');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  // No file on disk ⇒ phase closed ⇒ the fire starts normally.
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  // Returns NORMALLY — it did attempt work (D6), so this is not `skipped`.
  assert.equal(result.skipped, undefined);
  assert.deepEqual(
    result.jobs.map((j) => j.identity.id),
    ['li-6001'],
  );
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString());
  assert.equal(state?.tripCount, 1);
  // URL_2 was never visited: only ONE page was ever opened.
  assert.equal(provider.handle?.pages.length, 1);
  // The interrupted url is NOT marked done — the next fire must retry it.
  const persisted = storage.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.equal(Object.hasOwn(persisted.done, URL_1), false);
});

test('trip: a fire that trips before capturing anything still writes the breaker, and the pre-existing all-urls-failed guard still throws (spec §4.5 step 6)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Every card on URL_1 is a shell: the counter trips on card 3 with zero
  // captures to keep.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6701/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6702/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6703/',
    },
  ]);
  for (const id of ['6701', '6702', '6703']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6800');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  // Pinned deliberately rather than left unknown: with nothing captured,
  // the trip leaves the fire in exactly the shape the pre-existing
  // all-urls-failed guard is built to shout about, and spec §4.5 step 6
  // keeps those rules applying unchanged. So this run DOES fail loud — the
  // throttle guard changes what the next fire does, not whether this one
  // reports an outage it genuinely had.
  await assert.rejects(() => lane.source(fakeCtx()), /all 1 attempted url\(s\) failed/);

  // The breaker must have been written BEFORE that throw — otherwise the
  // next fire would relearn the block the expensive way instead of
  // skipping cheaply, which is the entire point of the guard.
  const state = fs.current();
  assert.equal(state?.openedAt, NOW.toISOString());
  assert.equal(state?.tripCount, 1);
  // And it stopped early all the same: URL_2 was never opened.
  assert.equal(provider.handle?.pages.length, 1);
});

test('trip: an ok between shells resets the streak — a mostly-healthy fire never trips', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6201/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6202/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6203/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Umbrella',
      location: 'Remote',
      href: '/jobs/view/6204/',
    },
  ]);
  // shell, shell, ok, shell -> longest streak 2, never trips.
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6201/');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6202/');
  script.jdTextByUrl.set('https://www.linkedin.com/jobs/view/6203/', 'JD text — healthy');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/6204/');
  seedTrivialUrl(script, URL_2, '6300');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.equal(fs.current(), undefined, 'breaker must stay closed');
  // Both urls were visited: 2 pages opened, and URL_2's job landed.
  assert.equal(provider.handle?.pages.length, 2);
  assert.ok(result.jobs.some((j) => j.identity.id === 'li-6300'));
});

test('no breaker configured: the lane never reads or writes breaker state (every legacy call site is unaffected)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/6401/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/6402/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/6403/',
    },
  ]);
  for (const id of ['6401', '6402', '6403']) {
    script.jdShellUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '6500');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();

  // 13th argument omitted entirely — the pre-throttle-guard call shape.
  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
  );

  const result = await lane.source(fakeCtx());

  // Three shells in a row and yet URL_2 still got visited: with no breaker
  // configured there is no counter and no early stop.
  assert.equal(result.skipped, undefined);
  assert.equal(provider.handle?.pages.length, 2);
});

test('all-urls-failed evidence: shell JD failures are reported as server-withheld content, not as an inventory problem (D13)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Two cards, both shells: jdRoot present, no text. Two is below the
  // 3-shell trip threshold, so the fire runs to completion and the
  // all-urls-failed guard produces the message under test.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/7001/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/7002/',
    },
  ]);
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/7001/');
  script.jdShellUrls.add('https://www.linkedin.com/jobs/view/7002/');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  let message = '';
  await assert.rejects(
    () => lane.source(fakeCtx()),
    (err: Error) => {
      message = err.message;
      return true;
    },
  );

  assert.match(message, /server withheld the JD content/);
  assert.match(message, /rate-limit|soft-block/);
  assert.match(message, /cooldown/);
  // The defining assertion: a throttle must NOT send anyone to the page
  // inventory or /page-analyse.
  assert.doesNotMatch(message, /page_inventory/);
  assert.doesNotMatch(message, /page-analyse/);
});

test('no trip: 3 consecutive JD-open failures whose jdRoot is present AND still holds text (a stale pane) leave the breaker closed (D4)', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  // Three cards in a row whose JD open fails while jdRoot matches an
  // element that still holds text — e.g. a goto timeout leaving the
  // PREVIOUS card's JD pane on screen. Under presence-only classification
  // these read as three shells and open a 4-hour breaker for something
  // that is not a throttle at all.
  script.harvestByUrl.set(URL_1, [
    {
      title: 'Frontend Engineer',
      company: 'Acme',
      location: 'Remote',
      href: '/jobs/view/7101/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Globex',
      location: 'Remote',
      href: '/jobs/view/7102/',
    },
    {
      title: 'Frontend Engineer',
      company: 'Initech',
      location: 'Remote',
      href: '/jobs/view/7103/',
    },
  ]);
  for (const id of ['7101', '7102', '7103']) {
    script.jdStalePaneUrls.add(`https://www.linkedin.com/jobs/view/${id}/`);
  }
  seedTrivialUrl(script, URL_2, '7200');
  const provider = new FakeBrowserProvider(script);
  const storage = new FakeStorage();
  const fs = fakeBreakerFs(undefined, NOW);

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    storage,
    undefined,
    0,
    0,
    () => 0.5,
    spySleepFn([]),
    0,
    0,
    { userDataDir: BREAKER_DIR, deps: fs.deps },
  );

  const result = await lane.source(fakeCtx());

  assert.equal(fs.current(), undefined, 'a stale populated pane must never trip');
  assert.deepEqual(fs.writes, []);
  // The fire ran to completion: URL_2 was still visited and captured.
  assert.equal(result.skipped, undefined);
  assert.equal(provider.handle?.pages.length, 2);
  assert.ok(result.jobs.some((j) => j.identity.id === 'li-7200'));
});
