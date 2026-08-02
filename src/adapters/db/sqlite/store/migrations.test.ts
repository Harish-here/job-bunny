import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LATEST_SCHEMA_VERSION, openJobsDb } from './migrations.ts';

function tmpDbPath(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), 'jb-sqlite-')),
    'nested',
    'jobbunny.db',
  );
}

function userVersion(db: ReturnType<typeof openJobsDb>): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
}

test('fresh :memory: db migrates to LATEST_SCHEMA_VERSION with jobs + tracking tables', () => {
  const db = openJobsDb(':memory:');
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  assert.ok(tables.includes('jobs'));
  assert.ok(tables.includes('tracking'));
  db.close();
});

test('file open creates parent directories and reopening is idempotent', () => {
  const dbPath = tmpDbPath();
  const first = openJobsDb(dbPath);
  first.close();
  const second = openJobsDb(dbPath);
  assert.equal(userVersion(second), LATEST_SCHEMA_VERSION);
  second.close();
});

test('a db stamped newer than LATEST_SCHEMA_VERSION throws loud', () => {
  const dbPath = tmpDbPath();
  const db = openJobsDb(dbPath);
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(() => openJobsDb(dbPath), /newer/);
});
