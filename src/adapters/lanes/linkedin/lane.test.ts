import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPTURE_PATH } from './capture_store.ts';
import { LinkedInLane } from './lane.ts';
import { RESUME_STATE_PATH } from './resume_state.ts';
import {
  FakeBrowserProvider,
  FakeStateStore,
  fakeCapturedJD,
  fakeCtx,
  fixtureFilterConfig,
  newScript,
  noopLogger,
  seedHappyPathScript,
  singlePageInventory,
  URL_1,
  URL_2,
} from './testkit/index.ts';

test('happy path: 2 urls, some cards gated out, surviving JDs opened, companiesSeen deduped, beat() ticked', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
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
    stateStore,
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
  const stateStore = new FakeStateStore();
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
    stateStore,
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
  const persisted = stateStore.get(RESUME_STATE_PATH) as { done: Record<string, number> };
  assert.equal(Object.hasOwn(persisted.done, URL_1), false);
  assert.equal(Object.hasOwn(persisted.done, URL_2), true);
});

test("one card's openJd throws (empty text): that card is skipped, other cards in the same url are still captured", async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.jdTextByUrl.delete('https://www.linkedin.com/jobs/view/1001/'); // Acme in url1 fails to open
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  const { jobs, dropped, companiesSeen } = await lane.source(ctx);

  const ids = jobs.map((jd) => jd.identity.id).sort();
  assert.deepEqual(ids, ['li-1003', 'li-2001', 'li-2002']);
  // companiesSeen is recorded at the card-gate step, before JD open —
  // Acme still counts as "seen" even though its JD open failed.
  assert.deepEqual([...companiesSeen].sort(), ['Acme', 'Globex', 'Initech']);

  // The url itself succeeded (only one card within it failed) — it must
  // still be marked done, unlike a whole-url failure.
  const persisted = stateStore.get(RESUME_STATE_PATH) as { done: Record<string, number> };
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
  const stateStore = new FakeStateStore();
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
    stateStore,
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
  const persisted = stateStore.get(RESUME_STATE_PATH) as { done: Record<string, number> };
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  stateStore.set(CAPTURE_PATH, [fakeCapturedJD('li-9001', 'EarlierCo')]);
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
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
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
    stateStore,
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
  const stateStore = new FakeStateStore();
  const today = new Date().toISOString().slice(0, 10);
  stateStore.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 2 } });
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const today = new Date().toISOString().slice(0, 10);
  stateStore.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 2 } });
  // url1's jobs from the earlier fire, already durably flushed.
  stateStore.set(CAPTURE_PATH, [
    fakeCapturedJD('li-1001', 'Acme'),
    fakeCapturedJD('li-1003', 'Globex'),
  ]);
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const today = new Date().toISOString().slice(0, 10);
  stateStore.set(RESUME_STATE_PATH, { date: today, done: { [URL_1]: 3, [URL_2]: 2 } });
  // A stale ghost from the earlier fire(s) today, no longer part of any
  // card this run harvests — rescanReset's capture-file clear must drop
  // it, or it would linger forever.
  stateStore.set(CAPTURE_PATH, [fakeCapturedJD('li-9999', 'GhostCo')]);
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(provider, [inv], [], fixtureFilterConfig(), stateStore);

  const { jobs } = await lane.source(ctx);
  assert.deepEqual(jobs, []);
});

test("newPage() throwing (dead CDP context) is this url's SoftError alone, not a whole-lane failure (finding 4)", async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  // url1 is the first newPage() call (index 0); url2 is the second (index 1).
  const provider = new FakeBrowserProvider(script, false, new Set([0]));
  const stateStore = new FakeStateStore();
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
    stateStore,
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  await lane.source(ctx);

  const resumeWrites = stateStore.writes.filter((path) => path === RESUME_STATE_PATH);
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
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  await lane.source(ctx);

  // 4 jobs are captured across both urls in the happy-path script — each
  // must have triggered its own persist to CAPTURE_PATH.
  const captureWrites = stateStore.writes.filter((path) => path === CAPTURE_PATH);
  assert.equal(captureWrites.length, 4);
});

test('handle.close() is always called, including when a url fails, and every opened page is closed', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  seedHappyPathScript(script);
  script.gotoThrows.add(URL_1);
  const provider = new FakeBrowserProvider(script);
  const stateStore = new FakeStateStore();
  const ctx = fakeCtx();

  const lane = new LinkedInLane(
    provider,
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
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
  const stateStore = new FakeStateStore();
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
    stateStore,
  );

  const { jobs } = await lane.source(ctx);

  assert.deepEqual(jobs, []);
  const groupWarning = warnings.find(
    (w) => (w as { msg: string }).msg === 'linkedin lane: no inventory found for page',
  ) as { data: { page: string } } | undefined;
  assert.ok(groupWarning);
  assert.equal(groupWarning.data.page, 'unknown-page');
});
