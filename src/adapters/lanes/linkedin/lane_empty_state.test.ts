import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkedInLane } from './lane.ts';
import { RESUME_STATE_PATH, type ResumeStateShape } from './resume_state.ts';
import {
  FakeBrowserProvider,
  FakeStateStore,
  fakeCtx,
  fixtureFilterConfig,
  newScript,
  singlePageInventory,
  URL_1,
  URL_2,
} from './testkit/index.ts';

/**
 * Lane-level coverage for behaviors.emptyStateMarker (the committed
 * inventory carries `svg#empty-room-small`): a search page that renders the
 * zero-results empty state is a clean empty url, not a failed one, so an
 * all-empty fire must not trip lane.ts's total-outage guard. Contrast with
 * lane.test.ts "every attempted url failing with zero cards harvested",
 * where no marker is present and the loud throw must stand.
 */

test('every attempted url rendering the empty-state marker: the lane returns normally, urls not failed', async () => {
  const inv = await singlePageInventory();
  assert.equal(inv.behaviors.emptyStateMarker, 'svg#empty-room-small');
  assert.equal(
    inv.behaviors.emptyStateRequires,
    'div[componentkey="searchResultsHeaderComponent"]',
  );
  const script = newScript();
  // The results container never attaches on an empty page; the marker does.
  script.emptyStateUrls.add(URL_1);
  script.emptyStateUrls.add(URL_2);
  const stateStore = new FakeStateStore();
  const lane = new LinkedInLane(
    new FakeBrowserProvider(script),
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  const result = await lane.source(fakeCtx());

  assert.deepEqual(result.jobs, []);
  // Marked done (not failed): a failed url is left out of resume state so a
  // later fire retries it.
  const resume = stateStore.get(RESUME_STATE_PATH) as ResumeStateShape;
  assert.equal(Object.hasOwn(resume.done, URL_1), true);
  assert.equal(Object.hasOwn(resume.done, URL_2), true);
});

test('one clean-empty url plus one genuinely failed url is not an all-failed outage, and only the failed url is left for retry', async () => {
  const inv = await singlePageInventory();
  const script = newScript();
  script.emptyStateUrls.add(URL_1);
  // URL_2: results container "attached" but zero cards -> minJobCards throw,
  // a failed url. One clean-empty + one failed is NOT all-failed.
  script.harvestByUrl.set(URL_2, []);
  const stateStore = new FakeStateStore();
  const lane = new LinkedInLane(
    new FakeBrowserProvider(script),
    [inv],
    [{ page: inv.page, urls: [URL_1, URL_2] }],
    fixtureFilterConfig(),
    stateStore,
  );

  const result = await lane.source(fakeCtx());
  assert.deepEqual(result.jobs, []);
  const resume = stateStore.get(RESUME_STATE_PATH) as ResumeStateShape;
  assert.equal(Object.hasOwn(resume.done, URL_1), true);
  assert.equal(Object.hasOwn(resume.done, URL_2), false);
});
