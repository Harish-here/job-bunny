import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { isSoftError } from '../../../core/errors/index.ts';
import type { PageHandle } from '../../../ports/browser.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import type { Inventory } from './inventory.ts';
import { InventorySchema } from './inventory.ts';
import { buildJdAnchorScript, openJd } from './jd_open.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function detailsPageInventory(): Promise<Inventory> {
  const raw = JSON.parse(
    await readFile(
      `${REPO_ROOT}src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json`,
      'utf8',
    ),
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

  const { text, source } = await openJd(
    page,
    { id: 'li-1', url: 'https://www.linkedin.com/jobs/view/1/' },
    inv,
    ctx,
  );

  assert.equal(text, 'About the job — we build things.');
  assert.equal(source, 'jdRoot');
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

  const { text } = await openJd(
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

// openJd's contract is "configured jdRoot selector first, anchor fallback
// second" — the fakes below dispatch on evaluate CALL ORDER (first call =
// jdRoot, second = anchor), not by sniffing the script source.

test('jdRoot waitFor times out but the configured selector still returns text: card succeeds, no throw', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    waitFor: async () => {
      throw new Error('waitFor(jdRoot) timed out');
    },
    evaluate: async () => 'About the job — we build things.' as never,
  });
  const ctx = fakeCtx();
  const card = { id: 'li-3', url: 'https://www.linkedin.com/jobs/view/3/' };

  const { text } = await openJd(page, card, inv, ctx);

  assert.equal(text, 'About the job — we build things.');
  assert.deepEqual(calls, [
    `goto:${card.url}`,
    `waitFor:${inv.selectors.jdRoot}`,
    'evaluate',
  ]);
});

test('jdRoot waitFor times out and the configured selector is empty: anchor fallback returns text, card succeeds', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  let evalCalls = 0;
  const page = fakePage(calls, {
    waitFor: async () => {
      throw new Error('waitFor(jdRoot) timed out');
    },
    evaluate: async () => {
      evalCalls += 1;
      return (evalCalls === 1 ? '' : 'About the job — anchor fallback.') as never;
    },
  });
  const ctx = fakeCtx();
  const card = { id: 'li-3b', url: 'https://www.linkedin.com/jobs/view/3b/' };

  const { text, source } = await openJd(page, card, inv, ctx);

  assert.equal(text, 'About the job — anchor fallback.');
  assert.equal(source, 'anchor');
  assert.deepEqual(calls, [
    `goto:${card.url}`,
    `waitFor:${inv.selectors.jdRoot}`,
    'evaluate',
    'evaluate',
  ]);
});

test('both the configured selector and the anchor fallback come back empty: fails exactly as before (SoftError, scope "url")', async () => {
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
      assert.match(
        (err as Error).message,
        /https:\/\/www\.linkedin\.com\/jobs\/view\/4\//,
      );
      assert.match((err as Error).message, /extracted JD text was empty/);
      return true;
    },
  );
  // Both evaluate scripts (configured selector, then anchor fallback) ran.
  assert.equal(calls.filter((c) => c === 'evaluate').length, 2);
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

// --- error fidelity (finding 6): aborts/dead CDP must not be relabeled ---

test('an AbortError from evaluate propagates with its real message — never relabeled as empty text, no anchor fallback attempted', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    evaluate: async () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
  });
  const ctx = fakeCtx();
  const card = { id: 'li-7', url: 'https://www.linkedin.com/jobs/view/7/' };

  await assert.rejects(
    () => openJd(page, card, inv, ctx),
    (err: unknown) => {
      assert.ok(isSoftError(err));
      assert.match((err as Error).message, /aborted/);
      assert.doesNotMatch((err as Error).message, /extracted JD text was empty/);
      return true;
    },
  );
  assert.equal(calls.filter((c) => c === 'evaluate').length, 1);
});

test('a "Target closed" CDP error from evaluate propagates with its real message', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  const page = fakePage(calls, {
    evaluate: async () => {
      throw new Error('Protocol error (Runtime.evaluate): Target closed');
    },
  });
  const ctx = fakeCtx();
  const card = { id: 'li-8', url: 'https://www.linkedin.com/jobs/view/8/' };

  await assert.rejects(
    () => openJd(page, card, inv, ctx),
    (err: unknown) => {
      assert.ok(isSoftError(err));
      assert.match((err as Error).message, /Target closed/);
      assert.doesNotMatch((err as Error).message, /extracted JD text was empty/);
      return true;
    },
  );
  assert.equal(calls.filter((c) => c === 'evaluate').length, 1);
});

test('a generic script error from the jdRoot evaluate still falls back to the anchor scan', async () => {
  const inv = await detailsPageInventory();
  const calls: string[] = [];
  let evalCalls = 0;
  const page = fakePage(calls, {
    evaluate: async () => {
      evalCalls += 1;
      if (evalCalls === 1) {
        throw new Error('ReferenceError: something page-side');
      }
      return 'About the job — recovered via anchor.' as never;
    },
  });
  const ctx = fakeCtx();
  const card = { id: 'li-9', url: 'https://www.linkedin.com/jobs/view/9/' };

  const { text, source } = await openJd(page, card, inv, ctx);
  assert.equal(text, 'About the job — recovered via anchor.');
  assert.equal(source, 'anchor');
});

// --- config-driven anchor (finding 7) & per-pageType wait timeout (finding 8) ---

test('the anchor script uses behaviors.jdAnchorText from the inventory, not a code constant', async () => {
  const inv = InventorySchema.parse({
    ...popupInventory(),
    behaviors: { jdAnchorText: 'Om jobbet', jdAnchorMinChars: '100' },
  });
  const calls: string[] = [];
  const anchorText = `Om jobbet — ${'x'.repeat(120)}`;
  let evalCalls = 0;
  const page = fakePage(calls, {
    evaluate: async (fn) => {
      evalCalls += 1;
      if (evalCalls === 1) return '' as never;
      // Second call is the anchor script — the assertion under test: it
      // must embed the inventory's phrase, not the code default.
      assert.match(fn as string, /Om jobbet/);
      assert.doesNotMatch(fn as string, /About the job/);
      return anchorText as never;
    },
  });
  const ctx = fakeCtx();

  const { text, source } = await openJd(
    page,
    { id: 'li-10', url: 'https://www.linkedin.com/jobs/view/10/' },
    inv,
    ctx,
  );
  assert.equal(text, anchorText);
  assert.equal(source, 'anchor');
});

test('details-page uses a short best-effort jdRoot wait; popup keeps the long one', async () => {
  const seen: Array<number | undefined> = [];
  const waitFor: PageHandle['waitFor'] = async (_selector, opts) => {
    seen.push(opts?.timeoutMs);
  };

  const detailsInv = await detailsPageInventory();
  await openJd(
    fakePage([], { waitFor, evaluate: async () => 'About the job — d.' as never }),
    { id: 'li-11', url: 'https://www.linkedin.com/jobs/view/11/' },
    detailsInv,
    fakeCtx(),
  );

  await openJd(
    fakePage([], { waitFor, evaluate: async () => 'About the job — p.' as never }),
    { id: 'li-12', url: 'https://www.linkedin.com/jobs/view/12/' },
    popupInventory(),
    fakeCtx(),
  );

  const [detailsTimeout, popupTimeout] = seen;
  assert.ok(
    (detailsTimeout ?? 0) <= 5_000,
    `details-page wait should be short, got ${detailsTimeout}`,
  );
  assert.equal(popupTimeout, 15_000);
});

// --- buildJdAnchorScript, evaluated over a fake `document` via node:vm ---

function fakeAnchorDocument(texts: string[]): unknown {
  const els = texts.map((t) => ({ innerText: t }));
  return {
    querySelectorAll(s: string) {
      return s === 'section, div, article, main' ? els : [];
    },
  };
}

test('buildJdAnchorScript picks the SHORTEST qualifying element when several match', async () => {
  const anchorText = 'About the job — ';
  const longer = `${anchorText}${'x'.repeat(220)}`;
  const shorter = `${anchorText}${'y'.repeat(200)}`;
  const document = fakeAnchorDocument([longer, shorter]);

  const result = await vm.runInNewContext(buildJdAnchorScript(), { document });

  assert.equal(result, shorter);
  assert.ok(result.length < longer.length);
});

test('buildJdAnchorScript ignores elements shorter than the minimum length or not starting with the anchor phrase', async () => {
  const tooShort = `About the job — ${'z'.repeat(50)}`; // starts right, too short
  const wrongStart = `Some other heading — ${'w'.repeat(300)}`; // long enough, wrong start
  const document = fakeAnchorDocument([tooShort, wrongStart]);

  const result = await vm.runInNewContext(buildJdAnchorScript(), { document });

  assert.equal(result, '');
});

test('buildJdAnchorScript honors a custom anchor phrase and minimum length', async () => {
  const match = `Om jobbet — ${'q'.repeat(100)}`;
  const document = fakeAnchorDocument([`About the job — ${'r'.repeat(300)}`, match]);

  const result = await vm.runInNewContext(buildJdAnchorScript('Om jobbet', 50), {
    document,
  });

  assert.equal(result, match);
});
