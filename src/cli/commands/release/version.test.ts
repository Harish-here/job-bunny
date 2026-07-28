/**
 * version.test.ts (split from release.test.ts) — pure-function coverage for
 * `./version.ts`. Mirrors v0 `scripts/ops/release.test.js`'s pure-function
 * coverage (parseVersion/changelogHasVersionBlock/packageJsonVersion/
 * updateReadmeBadge) plus `npmSwallowedFlags`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changelogHasVersionBlock,
  npmSwallowedFlags,
  packageJsonVersion,
  parseVersion,
  updateReadmeBadge,
} from './version.ts';

test('parseVersion accepts a plain X.Y.Z version', () => {
  assert.deepEqual(parseVersion('1.3.0'), {
    version: '1.3.0',
    major: 1,
    minor: 3,
    patch: 0,
  });
});

test('parseVersion rejects a leading v prefix', () => {
  assert.throws(() => parseVersion('v1.3.0'));
});

test('parseVersion rejects a 2-part version', () => {
  assert.throws(() => parseVersion('1.3'));
});

test('parseVersion rejects a prerelease suffix', () => {
  assert.throws(() => parseVersion('1.3.0-beta'));
});

test('changelogHasVersionBlock matches the exact em-dash heading', () => {
  const text = '## [1.2.1] — 2026-07-14\n';
  assert.equal(changelogHasVersionBlock(text, '1.2.1'), true);
});

test('changelogHasVersionBlock rejects a missing date', () => {
  assert.equal(changelogHasVersionBlock('## [1.2.1]\n', '1.2.1'), false);
});

test('packageJsonVersion extracts the version field', () => {
  assert.equal(packageJsonVersion('{"name":"job-bunny","version":"1.2.1"}'), '1.2.1');
});

test('updateReadmeBadge reports found:false when the badge is missing entirely', () => {
  const r = updateReadmeBadge('# README with no badge', '1.2.1');
  assert.equal(r.found, false);
  assert.equal(r.changed, false);
});

test('npmSwallowedFlags: detects flags npm consumed in a release lifecycle', () => {
  assert.deepEqual(
    npmSwallowedFlags({
      npm_lifecycle_event: 'release',
      npm_config_dry_run: 'true',
      npm_config_yes: 'true',
      npm_config_merge: '',
    }),
    ['--dry-run', '--no-merge', '--yes'],
  );
});

test('npmSwallowedFlags: empty when the flags were forwarded via -- (env unset)', () => {
  assert.deepEqual(npmSwallowedFlags({ npm_lifecycle_event: 'release' }), []);
});

test('npmSwallowedFlags: empty outside an npm release lifecycle', () => {
  assert.deepEqual(
    npmSwallowedFlags({ npm_config_dry_run: 'true', npm_config_yes: 'true' }),
    [],
  );
});
