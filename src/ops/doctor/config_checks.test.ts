import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyLanesCheck,
  filterParsesCheck,
  profileParsesCheck,
  sqlitePathRetiredCheck,
} from './config_checks.ts';

const VALID_PROFILE_JSON = JSON.stringify({
  lanes: ['linkedin'],
  connector: 'notion',
  notifiers: ['telegram'],
  routines: [],
  settings: {},
});

const VALID_FILTER_JSON = JSON.stringify({
  title: { domain: { match: ['frontend'], reject: [], severity: 'hard' } },
  locations: [{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }],
});

/** `fakeReadDoc` — a `readDoc` seam standing in for a profile's real
 * `ConfigStore.readText` (fix round, config→db Phase 4 follow-up): keys
 * present in `docs` resolve, absent keys resolve to `undefined` — never
 * throw ENOENT, mirroring `ConfigStore.readText`'s own contract (missing
 * is `undefined`, not an exception). */
function fakeReadDoc(
  docs: Record<string, string>,
): (key: string) => Promise<string | undefined> {
  return async (key: string) => docs[key];
}

// --- profileParsesCheck ---

test('profileParsesCheck: ok on valid profile.json matching the schema', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('profileParsesCheck: red on missing profile.json (no config_docs row, no legacy file)', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /profile\.json/);
});

test('profileParsesCheck: red on malformed JSON', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': '{ not json' }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('profileParsesCheck: red on schema-mismatch', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': JSON.stringify({ lanes: 'not-an-array' }) }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('profileParsesCheck: never throws — a readDoc throw (e.g. malformed legacy file) becomes a red finding', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    readDoc: async () => {
      throw new Error('disk on fire');
    },
  });
  await assert.doesNotReject(() => check.run());
  assert.equal((await check.run()).status, 'red');
});

test('profileParsesCheck: ok when profile.json exists only as a config_docs row (no legacy file at all)', async () => {
  const check = profileParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

// --- filterParsesCheck ---

test('filterParsesCheck: ok on valid filter.json matching the schema', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'filter.json': VALID_FILTER_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('filterParsesCheck: warn on missing filter.json (optional)', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'warn');
});

test('filterParsesCheck: red on malformed JSON', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'filter.json': '{ nope' }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('filterParsesCheck: red on schema-mismatch', async () => {
  const check = filterParsesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({
      'filter.json': JSON.stringify({
        locations: [{ city: 'X', workTypes: ['not-a-worktype'] }],
      }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

// --- emptyLanesCheck ---

test('emptyLanesCheck: red when profile.json has no lanes configured', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({
      'profile.json': JSON.stringify({
        lanes: [],
        connector: 'notion',
        notifiers: [],
        routines: [],
        settings: {},
      }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.match(finding.detail, /no lanes configured/);
});

test('emptyLanesCheck: ok when at least one lane is configured', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('emptyLanesCheck: stays ok (silent) when profile.json is missing — profileParsesCheck already reports that red', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({}),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('emptyLanesCheck: stays ok (silent) when profile.json fails schema validation — profileParsesCheck already reports that red', async () => {
  const check = emptyLanesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': JSON.stringify({ nope: true }) }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('emptyLanesCheck: ok — a freshly-built profile living ONLY in config_docs (no legacy file) is not silently skipped', async () => {
  // The false-silence this check exists to prevent (P9 closure register)
  // must not come back through the config-docs-only path: a profile whose
  // config lives entirely in the db, with at least one lane, still reports
  // ok — not "skipped — profile.json unreadable".
  const check = emptyLanesCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
  assert.doesNotMatch(finding.detail, /unreadable/);
});

// --- sqlitePathRetiredCheck (config→db Phase 4) ---

test('sqlitePathRetiredCheck: red when settings.sqlite.path is present, byte-exact message naming the profile', async () => {
  const check = sqlitePathRetiredCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({
      'profile.json': JSON.stringify({
        lanes: [],
        connector: 'sqlite',
        notifiers: [],
        routines: [],
        settings: { sqlite: { path: '/custom/mine.db' } },
      }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
  assert.equal(
    finding.detail,
    'settings.sqlite.path is no longer supported — the database always lives at ' +
      'profiles/rajni/data/jobbunny.db; move the file there and delete the setting',
  );
});

test('sqlitePathRetiredCheck: red even when the path value is malformed — checks key presence, not validity', async () => {
  const check = sqlitePathRetiredCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({
      'profile.json': JSON.stringify({ settings: { sqlite: { path: 123 } } }),
    }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'red');
});

test('sqlitePathRetiredCheck: ok when settings.sqlite has no path key', async () => {
  const check = sqlitePathRetiredCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': VALID_PROFILE_JSON }),
  });
  const finding = await check.run();
  assert.equal(finding.status, 'ok');
});

test('sqlitePathRetiredCheck: stays ok (silent) when profile.json is missing or not valid JSON — never throws', async () => {
  const missing = sqlitePathRetiredCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({}),
  });
  assert.equal((await missing.run()).status, 'ok');

  const malformed = sqlitePathRetiredCheck({
    profileName: 'rajni',
    readDoc: fakeReadDoc({ 'profile.json': '{ not json' }),
  });
  assert.equal((await malformed.run()).status, 'ok');
});
