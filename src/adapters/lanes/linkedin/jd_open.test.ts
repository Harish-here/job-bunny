import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isSoftError } from '../../../core/errors/index.ts';
import type { PageHandle } from '../../../ports/browser.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import type { Inventory } from './inventory.ts';
import { InventorySchema } from './inventory.ts';
import { openJd } from './jd_open.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function detailsPageInventory(): Promise<Inventory> {
  const raw = JSON.parse(
    await readFile(`${REPO_ROOT}page_inventory/linkedin__jobs-search.json`, 'utf8'),
  );
  const inv = InventorySchema.parse(raw);
  assert.equal(inv.pageType, 'details-page');
  return inv;
}

function popupInventory(): Inventory {
  return InventorySchema.parse({
    page: 'linkedin__jobs-search-popup-fixture',
    pageType: 'popup',
    generatedAt: '2026-07-01',
    selectors: {
      cardList: '.scaffold-layout__list',
      card: 'li[data-occludable-job-id]',
      cardTitle: '.artdeco-entity-lockup__title',
      cardCompany: '.artdeco-entity-lockup__subtitle',
      cardLocation: '.artdeco-entity-lockup__caption',
      cardLink: 'a.job-card-container__link',
      jdRoot: '.jobs-search__job-details--container',
    },
    behaviors: {},
  });
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {},
  };
}

interface FakePageOpts {
  goto?: PageHandle['goto'];
  click?: PageHandle['click'];
  waitFor?: PageHandle['waitFor'];
  evaluate?: PageHandle['evaluate'];
}

function fakePage(calls: string[], overrides: FakePageOpts = {}): PageHandle {
  return {
    goto: async (url, opts) => {
      calls.push(`goto:${url}`);
      if (overrides.goto) return overrides.goto(url, opts);
    },
    click: async (selector, opts) => {
      calls.push(`click:${selector}`);
      if (overrides.click) return overrides.click(selector, opts);
    },
    waitFor: async (selector, opts) => {
      calls.push(`waitFor:${selector}`);
      if (overrides.waitFor) return overrides.waitFor(selector, opts);
    },
    evaluate: async (fn, opts) => {
      calls.push('evaluate');
      if (overrides.evaluate) return overrides.evaluate(fn, opts);
      return undefined as never;
    },
    content: async () => '',
    close: async () => undefined,
  };
}

test('details-page happy path: goto -> waitFor(jdRoot) -> evaluate, in order, returns the JD text', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    evaluate: async () => 'About the job — we build things.' as never,
  });
  const ctx = fakeCtx();

  const text = await openJd(
    page,
    { id: 'li-1', url: 'https://www.linkedin.com/jobs/view/1/' },
    inv,
    ctx,
  );

  assert.equal(text, 'About the job — we build things.');
  assert.deepEqual(calls, [
    'goto:https://www.linkedin.com/jobs/view/1/',
    `waitFor:${inv.selectors.jdRoot}`,
    'evaluate',
  ]);
});

test('popup happy path: click(cardTitle) -> waitFor(jdRoot) -> evaluate, in order, returns the JD text', async () => {
  const inv = popupInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    evaluate: async () => 'About the job — popup flavor.' as never,
  });
  const ctx = fakeCtx();

  const text = await openJd(
    page,
    { id: 'li-2', url: 'https://www.linkedin.com/jobs/view/2/' },
    inv,
    ctx,
  );

  assert.equal(text, 'About the job — popup flavor.');
  assert.deepEqual(calls, [
    `click:${inv.selectors.cardTitle}`,
    `waitFor:${inv.selectors.jdRoot}`,
    'evaluate',
  ]);
});

test('a waitFor rejection throws a SoftError scoped "url", naming the card url', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    waitFor: async () => {
      throw new Error('selector never appeared');
    },
  });
  const ctx = fakeCtx();
  const card = { id: 'li-3', url: 'https://www.linkedin.com/jobs/view/3/' };

  await assert.rejects(
    () => openJd(page, card, inv, ctx),
    (err: unknown) => {
      assert.ok(isSoftError(err));
      assert.equal((err as { scope: string }).scope, 'url');
      assert.match(
        (err as Error).message,
        /https:\/\/www\.linkedin\.com\/jobs\/view\/3\//,
      );
      assert.match((err as Error).message, /selector never appeared/);
      return true;
    },
  );
});

test('empty extracted text throws a SoftError scoped "url"', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    evaluate: async () => '' as never,
  });
  const ctx = fakeCtx();
  const card = { id: 'li-4', url: 'https://www.linkedin.com/jobs/view/4/' };

  await assert.rejects(
    () => openJd(page, card, inv, ctx),
    (err: unknown) => {
      assert.ok(isSoftError(err));
      assert.equal((err as { scope: string }).scope, 'url');
      return true;
    },
  );
});

test('a non-Error throw (e.g. a rejected primitive) is still normalized into a SoftError, never escapes raw', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    goto: async () => {
      throw 'boom';
    },
  });
  const ctx = fakeCtx();
  const card = { id: 'li-5', url: 'https://www.linkedin.com/jobs/view/5/' };

  await assert.rejects(
    () => openJd(page, card, inv, ctx),
    (err: unknown) => {
      assert.ok(isSoftError(err));
      assert.match((err as Error).message, /boom/);
      return true;
    },
  );
});

test('openJd ticks ctx.beat() between the open step and waitFor on a happy path', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    evaluate: async () => 'About the job.' as never,
  });
  let beats = 0;
  const ctx: RunContext = {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {
      beats += 1;
    },
  };

  await openJd(
    page,
    { id: 'li-6', url: 'https://www.linkedin.com/jobs/view/6/' },
    inv,
    ctx,
  );

  assert.ok(beats >= 1);
});
