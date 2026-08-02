import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sqliteDbCheck } from './check.ts';
import { openJobsDb } from './store/index.ts';

function tmpPath(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'jb-check-')), name);
}

test('missing file is ok (created on first run)', async () => {
  const finding = await sqliteDbCheck({ path: tmpPath('jobbunny.db') }).run();
  assert.equal(finding.status, 'ok');
  assert.match(finding.detail, /first run/);
});

test('a migrated db is ok and reports its schema version', async () => {
  const dbPath = tmpPath('jobbunny.db');
  openJobsDb(dbPath).close();
  const finding = await sqliteDbCheck({ path: dbPath }).run();
  assert.equal(finding.status, 'ok');
  assert.match(finding.detail, /schema v1/);
});

test('a db stamped newer than this build is red', async () => {
  const dbPath = tmpPath('jobbunny.db');
  const db = openJobsDb(dbPath);
  db.exec('PRAGMA user_version = 99');
  db.close();
  const finding = await sqliteDbCheck({ path: dbPath }).run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /newer/);
});

test('an unopenable file is red, and run() does not throw', async () => {
  const dbPath = tmpPath('jobbunny.db');
  writeFileSync(dbPath, 'this is not a sqlite database, it is a haiku');
  const finding = await sqliteDbCheck({ path: dbPath }).run();
  assert.equal(finding.status, 'red');
});
