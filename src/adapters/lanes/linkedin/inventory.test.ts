import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ZodType } from 'zod';
import type { Storage } from '../../../ports/index.ts';
import type { Inventory } from './inventory.ts';
import { InventorySchema, inventoryFreshnessCheck, loadInventory } from './inventory.ts';

/** In-memory fake mirroring the real FsStorage contract: undefined for a
 * missing file, schema-validated (throws on mismatch) for a present one. */
class FakeStorage implements Storage {
  private readonly files = new Map<string, unknown>();

  set(relPath: string, value: unknown): void {
    this.files.set(relPath, value);
  }

  async readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined> {
    if (!this.files.has(relPath)) return undefined;
    return schema.parse(this.files.get(relPath));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    this.files.set(relPath, value);
  }
}

function fixtureInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    page: 'linkedin__jobs-search',
    pageType: 'details-page',
    generatedAt: '2026-07-01',
    selectors: {
      cardList: '.scaffold-layout__list',
      card: 'li[data-occludable-job-id]',
      cardTitle: '.artdeco-entity-lockup__title',
      cardCompany: '.artdeco-entity-lockup__subtitle',
      cardLocation: '.artdeco-entity-lockup__caption',
      cardLink: 'a.job-card-container__link',
      jdRoot: '#job-details',
    },
    behaviors: {},
    ...overrides,
  };
}

test('InventorySchema parses a valid inventory', () => {
  const result = InventorySchema.parse(fixtureInventory());
  assert.equal(result.page, 'linkedin__jobs-search');
  assert.equal(result.pageType, 'details-page');
  assert.deepEqual(result.behaviors, {});
});

test('InventorySchema rejects a bad pageType', () => {
  const bad = { ...fixtureInventory(), pageType: 'iframe' };
  assert.throws(() => InventorySchema.parse(bad));
});

test('InventorySchema rejects a missing required selector', () => {
  const fixture = fixtureInventory();
  const { cardList: _cardList, ...rest } = fixture.selectors;
  const bad = { ...fixture, selectors: rest };
  assert.throws(() => InventorySchema.parse(bad));
});

test('loadInventory returns the parsed inventory for a present page', async () => {
  const storage = new FakeStorage();
  storage.set('page_inventory/linkedin__jobs-search.json', fixtureInventory());
  const inv = await loadInventory(storage, 'linkedin__jobs-search');
  assert.equal(inv.selectors.card, 'li[data-occludable-job-id]');
});

test('loadInventory throws on a missing page inventory', async () => {
  const storage = new FakeStorage();
  await assert.rejects(
    () => loadInventory(storage, 'nope'),
    /missing page inventory for "nope"/,
  );
});

test('inventoryFreshnessCheck: ok when all pages present and fresh', async () => {
  const storage = new FakeStorage();
  const today = new Date().toISOString().slice(0, 10);
  storage.set(
    'page_inventory/a.json',
    fixtureInventory({ page: 'a', generatedAt: today }),
  );
  const check = inventoryFreshnessCheck(storage, ['a'], 30);
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
  assert.match(finding.detail, /1 page inventories present and fresh/);
});

test('inventoryFreshnessCheck: warn when generatedAt is older than maxAgeDays', async () => {
  const storage = new FakeStorage();
  storage.set(
    'page_inventory/a.json',
    fixtureInventory({ page: 'a', generatedAt: '2020-01-01' }),
  );
  const check = inventoryFreshnessCheck(storage, ['a'], 30);
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /a/);
});

test('inventoryFreshnessCheck: red when a page inventory is missing', async () => {
  const storage = new FakeStorage();
  const check = inventoryFreshnessCheck(storage, ['missing-page'], 30);
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /missing-page/);
});

const REPO_ROOT = fileURLToPath(new URL('../../../../page_inventory/', import.meta.url));

for (const page of ['linkedin__jobs-search', 'linkedin__jobs-search-results']) {
  test(`committed page_inventory/${page}.json validates against InventorySchema`, async () => {
    const raw = JSON.parse(await readFile(`${REPO_ROOT}${page}.json`, 'utf8'));
    const parsed = InventorySchema.parse(raw);
    assert.equal(parsed.page, page);
  });
}

test('inventoryFreshnessCheck: red detail also names stale pages alongside missing ones', async () => {
  const storage = new FakeStorage();
  storage.set(
    'page_inventory/stale.json',
    fixtureInventory({ page: 'stale', generatedAt: '2020-01-01' }),
  );
  const check = inventoryFreshnessCheck(storage, ['stale', 'missing'], 30);
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /missing/);
  assert.match(finding.detail, /stale/);
});
