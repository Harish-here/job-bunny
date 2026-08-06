import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { wire } from './compose.ts';

/**
 * compose.configdivergence.test.ts (fix round, critical finding) — proves,
 * against the REAL `SqliteConfigStore` + `wire()` composition (no fakes,
 * no synthetic fixtures the app never produces), that once a legacy config
 * doc has been lifted into `config_docs`, a later hand-edit of the legacy
 * file on disk is silently shadowed forever — and that
 * `configLegacyDivergenceCheck` (`ops/doctor/aggregate.ts`), wired into
 * `wire()`'s `coreChecks` in this same fix, is the doctor-visible guard
 * against exactly that.
 */

const dirs: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-wire-divergence-'));
  dirs.push(dir);
  return dir;
}

function writeLegacyDoc(root: string, name: string, doc: string, contents: string): void {
  const profileDir = path.join(root, 'profiles', name);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, doc), contents);
}

after(() => {
  // Windows file-lock belt, same precedent as every other real-fs wire
  // test in this module (compose.configstore.test.ts, compose.test.ts).
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('real repro: a hand-edit to filter.json after the one-time lift is silently shadowed by config_docs — configLegacyDivergenceCheck warns', async () => {
  const root = freshRoot();
  const name = 'driftme';
  writeLegacyDoc(
    root,
    name,
    'profile.json',
    JSON.stringify({
      lanes: [],
      connector: 'sqlite',
      notifiers: [],
      routines: [],
      settings: {},
    }),
  );
  writeLegacyDoc(
    root,
    name,
    'filter.json',
    JSON.stringify({ companies: { avoid: ['OldCo'] } }),
  );

  // Run 1: lifts filter.json's ['OldCo'] into config_docs — the documented
  // one-time lift (`SqliteConfigStore`'s own doc comment).
  const first = await wire(name, { root });
  first.ctx.runStore.close();

  // The user hand-edits the legacy file directly, never through `jobbunny
  // config set` — exactly the scenario the finding describes.
  writeLegacyDoc(
    root,
    name,
    'filter.json',
    JSON.stringify({ companies: { avoid: ['OldCo', 'NewlyAvoidedCo'] } }),
  );

  // Run 2: the SAME real adapter, against the SAME real db file — the
  // config_docs row still wins; the hand-edit is invisible to anything
  // that reads via the store.
  const second = await wire(name, { root });
  second.ctx.runStore.close();

  const divergenceCheck = second.checks.find(
    (c) => c.name === 'config-legacy-divergence',
  );
  assert.ok(
    divergenceCheck,
    'expected wire() to contribute a config-legacy-divergence doctor check',
  );
  const finding = await divergenceCheck.run();
  assert.equal(finding.status, 'warn');
  assert.match(finding.detail, /filter\.json/);
  assert.match(
    finding.detail,
    new RegExp(`jobbunny config import --profile ${name} --dir profiles/${name}`),
  );
});

test('no divergence: an unmodified legacy file after lift reports ok', async () => {
  const root = freshRoot();
  const name = 'nodrift';
  writeLegacyDoc(
    root,
    name,
    'profile.json',
    JSON.stringify({
      lanes: [],
      connector: 'sqlite',
      notifiers: [],
      routines: [],
      settings: {},
    }),
  );

  const first = await wire(name, { root });
  first.ctx.runStore.close();

  const second = await wire(name, { root });
  second.ctx.runStore.close();

  const divergenceCheck = second.checks.find(
    (c) => c.name === 'config-legacy-divergence',
  );
  assert.ok(divergenceCheck);
  const finding = await divergenceCheck.run();
  assert.equal(finding.status, 'ok');
});
