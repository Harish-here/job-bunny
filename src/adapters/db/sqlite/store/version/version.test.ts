import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openJobsDb } from '../../index.ts';
import { readSchemaVersionReadonly } from './version.ts';

function tmpPath(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'jb-version-')), name);
}

test('a path that does not exist returns undefined and does not throw', () => {
  const result = readSchemaVersionReadonly(tmpPath('jobbunny.db'));
  assert.equal(result, undefined);
});

test('a file with non-sqlite bytes returns undefined and does not throw', () => {
  const dbPath = tmpPath('jobbunny.db');
  writeFileSync(dbPath, 'not a sqlite database');
  const result = readSchemaVersionReadonly(dbPath);
  assert.equal(result, undefined);
});

test('a schema-newer-than-build file returns the real unclamped version', () => {
  const dbPath = tmpPath('jobbunny.db');
  const db = openJobsDb(dbPath);
  db.exec('PRAGMA user_version = 99');
  db.close();
  const result = readSchemaVersionReadonly(dbPath);
  assert.equal(result, 99);
});
