import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { wireBoard } from './board.ts';

let root: string;

function profileDir(name: string): string {
  return path.join(root, 'profiles', name);
}

function writeProfile(name: string, contents: unknown): void {
  mkdirSync(profileDir(name), { recursive: true });
  writeFileSync(
    path.join(profileDir(name), 'profile.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

// `removeProfile`'s "running"/"crashed" tests seed a raw `runs` row. This
// file may not import `src/adapters/**` directly (no test-file exemption
// from `only-wire-imports-adapters` — only `board.ts` itself is carved
// out, same posture as `daemon.test.ts`), so seeding goes through
// `node:sqlite` (a node builtin) directly against an already-migrated db
// file — see each test's own setup for how migration is triggered first.
function insertRunRow(dbPath: string, status: string, heartbeatAt: string): number {
  const db = new DatabaseSync(dbPath);
  const result = db
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at, heartbeat_at)
       VALUES ('2026-08-07', '10-00', 'run', ?, '2026-08-07T10:00:00.000Z', ?)`,
    )
    .run(status, heartbeatAt);
  db.close();
  return Number(result.lastInsertRowid);
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-wire-'));

  // 'a' — a valid sqlite profile WITH a real db file. This test file may
  // not import `adapters/db/sqlite` (no test-file exemption from
  // `only-wire-imports-adapters` — only `board.ts` itself is carved out),
  // so the fixture db is a zero-byte file: sqlite treats that as a valid,
  // uninitialized database (`PRAGMA user_version` reads 0), and
  // `wireBoard`'s own `openStore` — which DOES import the real
  // `openJobsDb` — applies the real forward migrations on first open.
  writeProfile('a', { connector: 'sqlite' });
  const aDbPath = path.join(profileDir('a'), 'data', 'jobbunny.db');
  mkdirSync(path.dirname(aDbPath), { recursive: true });
  writeFileSync(aDbPath, '');

  // 'b' — connector: 'notion', no db file.
  writeProfile('b', { connector: 'notion' });

  // 'malformed' — unparsable JSON, no db file.
  writeProfile('malformed', '{ not json');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('wireBoard — listProfiles', () => {
  test('discovers directories, sorted, tolerant of malformed profile.json', async () => {
    const source = wireBoard({ root });
    const profiles = await source.listProfiles();
    assert.deepEqual(
      profiles.map((p) => p.name),
      ['a', 'b', 'malformed'],
    );
    const a = profiles.find((p) => p.name === 'a');
    assert.deepEqual(a, { name: 'a', connector: 'sqlite', hasDb: true });
    const b = profiles.find((p) => p.name === 'b');
    assert.deepEqual(b, { name: 'b', connector: 'notion', hasDb: false });
    const malformed = profiles.find((p) => p.name === 'malformed');
    assert.deepEqual(malformed, { name: 'malformed', connector: '', hasDb: false });
    source.close();
  });

  test("a profile whose jobbunny.db predates config_docs (schema v4) tolerates the missing table and lifts from its legacy profile.json (plumbing reaches SqliteConfigStore's own readonly tolerance)", async () => {
    writeProfile('legacy-db', { connector: 'sqlite' });
    const dbPath = path.join(profileDir('legacy-db'), 'data', 'jobbunny.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    // A zero-byte file opens fine as a valid, un-migrated (schema-v0,
    // definitely pre-config_docs) sqlite db — `SELECT ... FROM
    // config_docs` against it throws "no such table: config_docs", which
    // `SqliteConfigStore`'s readonly lift tolerates by falling back to
    // this profile's own legacy `profile.json` file.
    writeFileSync(dbPath, '');

    const source = wireBoard({ root });
    const profiles = await source.listProfiles();
    const legacy = profiles.find((p) => p.name === 'legacy-db');
    assert.deepEqual(legacy, { name: 'legacy-db', connector: 'sqlite', hasDb: true });
    source.close();
  });

  test('a corrupt jobbunny.db (readonly open throws for a reason OTHER than "no such table") still degrades connector to \'\' in listProfiles() output, rather than throwing out of listProfiles itself', async () => {
    writeProfile('corrupt', { connector: 'sqlite' });
    const dbDir = path.join(profileDir('corrupt'), 'data');
    mkdirSync(dbDir, { recursive: true });
    // A non-empty, non-sqlite file: `new DatabaseSync(path, { readOnly:
    // true })` throws "file is not a database" — a genuinely different
    // failure mode than the tolerated "no such table" case above, and one
    // `SqliteConfigStore`'s readonly mode does NOT tolerate (it propagates
    // loud, per that class's own doc comment). `readProfileInfo`'s
    // whole-probe try/catch is what keeps THIS module's discovery alive.
    writeFileSync(path.join(dbDir, 'jobbunny.db'), 'not a real sqlite file, just bytes');

    const source = wireBoard({ root });
    const profiles = await source.listProfiles();
    // Discovery for every OTHER profile must survive.
    assert.deepEqual(
      profiles.map((p) => p.name).sort(),
      ['a', 'b', 'corrupt', 'legacy-db', 'malformed'].sort(),
    );
    const corrupt = profiles.find((p) => p.name === 'corrupt');
    assert.equal(corrupt?.connector, '');
    assert.equal(corrupt?.hasDb, true); // the file exists, just unreadable.
    source.close();
  });
});

describe('wireBoard — openStore', () => {
  test('opens a real store for a valid sqlite profile with a db file', async () => {
    const source = wireBoard({ root });
    const store = await source.openStore('a');
    assert.ok(store);
    assert.equal(typeof store.listJobs, 'function');
    assert.equal(typeof store.getJob, 'function');
    assert.equal(typeof store.updateTracking, 'function');
    assert.equal(typeof store.close, 'function');
    source.close();
  });

  test('returns null for a discovered profile with no db (notion connector)', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('b'), null);
    source.close();
  });

  test('returns null for an unknown profile name', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('does-not-exist'), null);
    source.close();
  });

  test('traversal probe: "../a" is rejected by the membership gate', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('../a'), null);
    source.close();
  });

  test('traversal probe: "a/../a" is rejected by the membership gate', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.openStore('a/../a'), null);
    source.close();
  });

  test('memoizes: two openStore("a") calls return the same reference', async () => {
    const source = wireBoard({ root });
    const first = await source.openStore('a');
    const second = await source.openStore('a');
    assert.equal(first, second);
    source.close();
  });

  test('close() then openStore("a") returns a fresh, working instance', async () => {
    const source = wireBoard({ root });
    const first = await source.openStore('a');
    source.close();
    const second = await source.openStore('a');
    assert.ok(second);
    assert.notEqual(first, second);
    assert.deepEqual(second.listJobs({}), { rows: [], total: 0 });
    source.close();
  });

  test('openStore on a hasDb-false profile never creates the db file', async () => {
    const source = wireBoard({ root });
    const dbPath = path.join(profileDir('b'), 'data', 'jobbunny.db');
    assert.equal(existsSync(dbPath), false);
    assert.equal(await source.openStore('b'), null);
    assert.equal(existsSync(dbPath), false);
    source.close();
  });
});

describe('wireBoard — readConfigDoc/writeConfigDoc', () => {
  test('readConfigDoc lifts a legacy profile.json for a real profile', async () => {
    const source = wireBoard({ root });
    const text = await source.readConfigDoc('a', 'profile.json');
    assert.equal(text, JSON.stringify({ connector: 'sqlite' }));
    source.close();
  });

  test('readConfigDoc returns undefined for a doc never written/lifted', async () => {
    const source = wireBoard({ root });
    const text = await source.readConfigDoc('a', 'resume.json');
    assert.equal(text, undefined);
    source.close();
  });

  test('readConfigDoc returns undefined for an unknown profile name', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.readConfigDoc('does-not-exist', 'profile.json'), undefined);
    source.close();
  });

  test('readConfigDoc returns undefined for a traversal probe on name', async () => {
    const source = wireBoard({ root });
    assert.equal(await source.readConfigDoc('../a', 'profile.json'), undefined);
    source.close();
  });

  test('writeConfigDoc round-trips through readConfigDoc for a real profile', async () => {
    const source = wireBoard({ root });
    const filterJson = JSON.stringify({ locations: [] });
    await source.writeConfigDoc('a', 'filter.json', filterJson);
    assert.equal(await source.readConfigDoc('a', 'filter.json'), filterJson);
    source.close();
  });

  test('writeConfigDoc surfaces the real validator message unmodified on an invalid doc', async () => {
    const source = wireBoard({ root });
    await assert.rejects(
      () => source.writeConfigDoc('a', 'filter.json', '{ not json'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^filter\.json is invalid:/);
        return true;
      },
    );
    source.close();
  });

  test('writeConfigDoc rejects a profile.json carrying settings.sqlite.path — the board can no longer persist a config that bricks doctor/wire for this profile (fix round)', async () => {
    const source = wireBoard({ root });
    await assert.rejects(
      () =>
        source.writeConfigDoc(
          'a',
          'profile.json',
          JSON.stringify({
            connector: 'sqlite',
            settings: { sqlite: { path: '/x.db' } },
          }),
        ),
      /settings\.sqlite\.path is no longer supported/,
    );
    // Never partially applied: the pre-existing lifted profile.json must
    // survive unchanged.
    assert.equal(
      await source.readConfigDoc('a', 'profile.json'),
      JSON.stringify({ connector: 'sqlite' }),
    );
    source.close();
  });

  test('writeConfigDoc throws "unknown profile" for an unknown name', async () => {
    const source = wireBoard({ root });
    await assert.rejects(
      () => source.writeConfigDoc('does-not-exist', 'filter.json', '{}'),
      /unknown profile: does-not-exist/,
    );
    source.close();
  });
});

describe('wireBoard — createProfile', () => {
  test('happy path: all four docs readable afterward, db file exists', async () => {
    const source = wireBoard({ root });
    await source.createProfile('freshling');
    const profileJson = await source.readConfigDoc('freshling', 'profile.json');
    const filterJson = await source.readConfigDoc('freshling', 'filter.json');
    const searchUrls = await source.readConfigDoc('freshling', 'search_urls.md');
    assert.ok(profileJson);
    assert.ok(filterJson);
    assert.ok(searchUrls);
    // resume.json is deliberately never seeded (hand-maintained).
    assert.equal(await source.readConfigDoc('freshling', 'resume.json'), undefined);
    const dbPath = path.join(profileDir('freshling'), 'data', 'jobbunny.db');
    assert.equal(existsSync(dbPath), true);
    source.close();
  });

  test('duplicate name throws "profile already exists"', async () => {
    const source = wireBoard({ root });
    await assert.rejects(() => source.createProfile('a'), /profile already exists: a/);
    source.close();
  });

  test('bad name throws WITHOUT touching the filesystem', async () => {
    const source = wireBoard({ root });
    await assert.rejects(
      () => source.createProfile('Bad Name!'),
      /invalid profile name: Bad Name!/,
    );
    assert.equal(existsSync(profileDir('Bad Name!')), false);
    source.close();
  });
});

describe('wireBoard — removeProfile', () => {
  test('an unknown name is not_found and no directory is touched', async () => {
    const source = wireBoard({ root });
    const outcome = await source.removeProfile('does-not-exist-remove');
    assert.deepEqual(outcome, { outcome: 'not_found' });
    assert.equal(existsSync(profileDir('does-not-exist-remove')), false);
    source.close();
  });

  test('rajni is protected', async () => {
    writeProfile('rajni', { connector: 'sqlite' });
    const source = wireBoard({ root });
    const outcome = await source.removeProfile('rajni');
    assert.deepEqual(outcome, { outcome: 'protected' });
    assert.equal(existsSync(profileDir('rajni')), true);
    source.close();
  });

  test("a profile whose newest run is 'running' is run_in_progress with that run's id", async () => {
    writeProfile('running-profile', { connector: 'sqlite' });
    const dbPath = path.join(profileDir('running-profile'), 'data', 'jobbunny.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, ''); // valid, unmigrated empty sqlite db.

    const migrateSource = wireBoard({ root });
    await migrateSource.openStore('running-profile'); // applies real migrations.
    migrateSource.close();

    const runId = insertRunRow(dbPath, 'running', new Date().toISOString());

    const source = wireBoard({ root });
    const outcome = await source.removeProfile('running-profile');
    assert.deepEqual(outcome, { outcome: 'run_in_progress', runId });
    assert.equal(existsSync(profileDir('running-profile')), true);
    source.close();
  });

  test("a profile whose newest run is 'crashed' is NOT blocked and gets removed", async () => {
    writeProfile('crashed-profile', { connector: 'sqlite' });
    const dbPath = path.join(profileDir('crashed-profile'), 'data', 'jobbunny.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, '');

    const migrateSource = wireBoard({ root });
    await migrateSource.openStore('crashed-profile');
    migrateSource.close();

    // A stale heartbeat (far older than RUN_HEARTBEAT_STALE_MS) derives
    // 'crashed' on read, even though the stored column is still 'running'.
    insertRunRow(dbPath, 'running', '2020-01-01T00:00:00.000Z');

    const source = wireBoard({ root });
    const outcome = await source.removeProfile('crashed-profile');
    assert.deepEqual(outcome, { outcome: 'removed' });
    assert.equal(existsSync(profileDir('crashed-profile')), false);
    const remaining = await source.listProfiles();
    assert.ok(!remaining.some((p) => p.name === 'crashed-profile'));
    source.close();
  });

  test('a profile with a fresh pending intent is intent_pending', async () => {
    writeProfile('pending-profile', { connector: 'sqlite' });
    const source = wireBoard({ root });
    const intents = await source.openIntents('pending-profile');
    assert.ok(intents);
    const { intent } = intents.request(new Date().toISOString());

    const outcome = await source.removeProfile('pending-profile');
    assert.deepEqual(outcome, { outcome: 'intent_pending', intentId: intent.id });
    assert.equal(existsSync(profileDir('pending-profile')), true);
    source.close();
  });

  test('a profile whose only intent is expired is NOT blocked and gets removed', async () => {
    writeProfile('expired-profile', { connector: 'sqlite' });
    const source = wireBoard({ root });
    const intents = await source.openIntents('expired-profile');
    assert.ok(intents);
    // Far older than INTENT_EXPIRY_MS (10 minutes) — derives 'expired' on read.
    intents.request('2020-01-01T00:00:00.000Z');

    const outcome = await source.removeProfile('expired-profile');
    assert.deepEqual(outcome, { outcome: 'removed' });
    assert.equal(existsSync(profileDir('expired-profile')), false);
    const remaining = await source.listProfiles();
    assert.ok(!remaining.some((p) => p.name === 'expired-profile'));
    source.close();
  });
});

describe('wireBoard — runDoctor (fix round: configStore leak)', () => {
  // `lsof -p <pid>` filtered to this profile's own db path — a real,
  // OS-observed count of open file descriptors, not a synthetic mock. On
  // the pre-fix code (`const { checks } = await wire(...)`, `configStore`
  // never destructured/closed) this same setup measurably grows by one fd
  // per call; verified by hand against the buggy version before writing
  // this test. `lsof` is posix-only, so the growth assertion is skipped on
  // win32 — `runDoctor` itself is still exercised there for basic sanity.
  function countOpenFdsFor(dbPath: string): number {
    const out = execSync(`lsof -p ${process.pid}`, { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.includes(dbPath)).length;
  }

  test('repeated calls do not accumulate open configStore file descriptors', async () => {
    writeProfile('doctor-leak', { connector: 'sqlite' });
    const dbPath = path.join(profileDir('doctor-leak'), 'data', 'jobbunny.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, '');

    const source = wireBoard({ root });
    await source.runDoctor('doctor-leak'); // warm-up: first open/close.
    assert.ok((await source.runDoctor('doctor-leak'))?.status);

    if (process.platform !== 'win32') {
      const before = countOpenFdsFor(dbPath);
      for (let i = 0; i < 5; i += 1) await source.runDoctor('doctor-leak');
      const after = countOpenFdsFor(dbPath);
      assert.equal(
        after,
        before,
        'runDoctor must close its own short-lived configStore every call',
      );
    }
    source.close();
  });

  test('the profile directory (and its jobbunny.db) is still removable after doctor calls', async () => {
    writeProfile('doctor-removable', { connector: 'sqlite' });
    const dbPath = path.join(profileDir('doctor-removable'), 'data', 'jobbunny.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, '');

    const source = wireBoard({ root });
    await source.runDoctor('doctor-removable');
    await source.runDoctor('doctor-removable');
    const outcome = await source.removeProfile('doctor-removable');
    assert.deepEqual(outcome, { outcome: 'removed' });
    assert.equal(existsSync(profileDir('doctor-removable')), false);
    source.close();
  });
});

describe('wireBoard — writeSecret (fix round: process.env visibility)', () => {
  test('writeSecret updates process.env[key] in the running process, not just the file', async () => {
    const original = process.env.NOTION_TOKEN;
    try {
      delete process.env.NOTION_TOKEN;
      const source = wireBoard({ root });
      assert.equal(process.env.NOTION_TOKEN, undefined);
      await source.writeSecret('NOTION_TOKEN', 'tok-fix-round-secret');
      assert.equal(process.env.NOTION_TOKEN, 'tok-fix-round-secret');
      source.close();
    } finally {
      if (original === undefined) delete process.env.NOTION_TOKEN;
      else process.env.NOTION_TOKEN = original;
    }
  });
});

describe('wireBoard — writeSecret (fix round 2: explicit chmod 0o600)', () => {
  test('writeSecret chmods .env to 0o600 after writing, even when the file already existed', async () => {
    const original = process.env.NOTION_TOKEN;
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    try {
      delete process.env.NOTION_TOKEN;
      // Pre-existing `.env`, so `writeFile`'s own `{ mode: 0o600 }` (which
      // only applies on create) would NOT be the thing enforcing this.
      writeFileSync(path.join(root, '.env'), 'UNRELATED=keep\n');
      const source = wireBoard({
        root,
        chmodEnvFile: async (p, mode) => {
          chmodCalls.push({ path: p, mode });
        },
      });
      await source.writeSecret('NOTION_TOKEN', 'tok-chmod-secret');
      assert.equal(chmodCalls.length, 1);
      assert.equal(chmodCalls[0]?.path, path.join(root, '.env'));
      assert.equal(chmodCalls[0]?.mode, 0o600);
      source.close();
    } finally {
      if (original === undefined) delete process.env.NOTION_TOKEN;
      else process.env.NOTION_TOKEN = original;
    }
  });
});
