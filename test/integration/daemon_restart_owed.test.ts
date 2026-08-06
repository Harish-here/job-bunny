/**
 * test/integration/daemon_restart_owed.test.ts — lives OUTSIDE `src/`
 * (mirrors `test/invariants/filesize.test.ts`'s own placement) precisely
 * so it can exercise the REAL cross-layer path end to end: `ops/daemon`'s
 * `createDaemon` wired to a REAL `cli/wire/daemon.ts` `wireDaemonRunHistory`
 * reading a REAL `SqliteRunStore` (`adapters/db/sqlite/runs`) over a real
 * on-disk `jobbunny.db`, plus a REAL pidfile (`ops/daemon/pidfile.ts`).
 * `dependency-cruiser`'s `includeOnly: '^src'` never cruises this file, so
 * it is free to import both `cli/wire` and `adapters` the way no file
 * under `src/` may (`only-wire-imports-adapters`) — the same carve-out
 * documented for `run_cap_backstop.test.ts`.
 *
 * Regression this pins: a daemon RESTART (`serve stop` + `serve start`,
 * a reboot via darwin autostart, or a crash-restart) wipes the pidfile's
 * own `attempts` ledger — `serve stop` unlinks it and `serve start`
 * creates a fresh one. Within `graceMinutes` (default 90) of a slot that
 * a PRIOR daemon process already spawned for real (a genuine `runs` row
 * exists in that profile's own `jobbunny.db`, written the instant
 * `run.ts` opened it, before any checkpoint), a restarted daemon with no
 * on-disk run-folder scan and no ledger memory must still recognize that
 * slot as served — never spawn `jobbunny run` a second time.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SqliteRunStore } from '../../src/adapters/db/sqlite/runs/index.ts';
import { wireDaemonRunHistory } from '../../src/cli/wire/index.ts';
import type { DaemonDeps, SpawnRun } from '../../src/ops/daemon/daemon.ts';
import { createDaemon } from '../../src/ops/daemon/daemon.ts';
import { acquireDaemonPidfile, defaultDaemonPidfileDeps } from '../../src/ops/daemon/index.ts';
import { defaultScanDeps } from '../../src/ops/daemon/scan/index.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-daemon-restart-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('a daemon restarted within grace does not re-spawn a slot a prior process already served (real SqliteRunStore + real pidfile)', async () => {
  const profile = 'harish';
  const profileDir = join(root, 'profiles', profile);
  await mkdir(join(profileDir, 'data'), { recursive: true });
  await writeFile(
    join(profileDir, 'profile.json'),
    JSON.stringify({
      connector: 'sqlite',
      schedule: { times: ['14:00'], enabled: true, graceMinutes: 90 },
    }),
  );

  // 2026-07-27 is a Monday — inside the default [1,2,3,4,5] weekdays.
  const now = new Date(2026, 6, 27, 14, 4);
  const date = '2026-07-27';

  // The PRIOR daemon process's real evidence: `run.ts` opens a `runs` row
  // the instant it starts, before any checkpoint exists — this is exactly
  // what a scheduled run that crashed (or is simply still starting up)
  // leaves behind. No pidfile ledger entry survives past this point: the
  // NEXT block simulates a restart with a totally fresh pidfile.
  const dbPath = join(profileDir, 'data', 'jobbunny.db');
  const seedStore = new SqliteRunStore(dbPath);
  seedStore.startRun({
    date,
    timeDir: '14-00',
    kind: 'run',
    startedAt: now.toISOString(),
  });
  seedStore.close();

  // A FRESH pidfile — `serve stop` unlinks the old one and `serve start`
  // creates this one, with an empty `attempts` ledger. This is the
  // restart the finding is about.
  const pidfileDeps = defaultDaemonPidfileDeps();
  const acquired = acquireDaemonPidfile(root, 12345, pidfileDeps);
  assert.ok(acquired, 'expected a fresh pidfile to acquire cleanly');

  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    return 0;
  };

  const deps: DaemonDeps = {
    root,
    profilesDir: join(root, 'profiles'),
    scan: defaultScanDeps(),
    pidfile: pidfileDeps,
    spawnRun,
    readRunHistory: wireDaemonRunHistory({ root }),
    log: () => {},
    now: () => now,
  };

  await createDaemon(deps).tick();

  assert.deepEqual(
    spawnCalls,
    [],
    'the restarted daemon must not duplicate a slot the runs table already shows attempted',
  );
});
