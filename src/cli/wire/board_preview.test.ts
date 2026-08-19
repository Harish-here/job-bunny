/**
 * board_preview.test.ts (fix round, task 10) — `previewFilterRule`'s REAL
 * orchestration (`board_preview.ts`), exercised through `wireBoard`'s own
 * delegate (`board.ts`) against a REAL temporary home: same posture as
 * `board.test.ts`/`board_doctor.test.ts` — no fakes for the store layer,
 * only an on-disk profile fixture with raw `runs`/`checkpoints` rows seeded
 * via `node:sqlite` directly (a node builtin, not an adapter import — this
 * file may not import `src/adapters/**`, only `board.ts`'s own carve-out
 * exemption may).
 *
 * Going through `wireBoard(...).previewFilterRule(...)` (rather than
 * calling `board_preview.ts`'s exported function with hand-built deps)
 * deliberately exercises BOTH halves the fix-round finding flagged as
 * untested: `board.ts`'s delegating method (which constructs a real
 * `SqliteCheckpointStore` via `openCheckpointStore`) AND
 * `board_preview.ts`'s own listRuns-iteration / first-hit-wins /
 * branch-selection / defensive-guard logic — the actual shipped code path,
 * not a parallel reimplementation (see `app/features/preview/routes.test.ts`
 * for why that file's fake couldn't do this: `app` may not import `cli`).
 *
 * Fix round (adversarial review, finding 1) — two tests below seed a
 * deliberately corrupted `filter.json` DIRECTLY into `config_docs` (raw
 * SQL, bypassing `writeConfigDoc`'s own validation, exactly like
 * `insertCheckpoint` bypasses the pipeline to seed a checkpoint) and assert
 * `previewFilterRule` throws something OTHER than
 * `InvalidDraftFilterConfigError` — proving the stored-config-corruption
 * failure is never misattributed as the caller's draft being invalid.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { FilterPreviewResult } from '../../ports/board.ts';
import { isInvalidDraftFilterConfigError } from '../../ports/board_preview.ts';
import { wireBoard } from './board.ts';

let root: string;

function profileDir(name: string): string {
  return path.join(root, 'profiles', name);
}

function dbPathFor(name: string): string {
  return path.join(profileDir(name), 'data', 'jobbunny.db');
}

function writeProfile(name: string): void {
  mkdirSync(profileDir(name), { recursive: true });
  writeFileSync(
    path.join(profileDir(name), 'profile.json'),
    JSON.stringify({ connector: 'sqlite' }),
  );
}

/** Creates a valid-but-unmigrated empty sqlite db file, then applies real
 * forward migrations via `wireBoard`'s own `openStore` (this file may not
 * import `openJobsDb` directly) — same two-step dance `board.test.ts` uses
 * for its `removeProfile` fixtures. */
async function migrateProfile(name: string): Promise<void> {
  const dbPath = dbPathFor(name);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, '');
  const migrateSource = wireBoard({ root });
  await migrateSource.openStore(name);
  migrateSource.close();
}

/** Seeds a raw `runs` row and returns its id — mirrors `board.test.ts`'s
 * own `insertRunRow` helper, widened to control `run_date`/`time_dir`. */
function insertRun(
  name: string,
  runDate: string,
  timeDir: string,
  startedAt: string,
): number {
  const db = new DatabaseSync(dbPathFor(name));
  const result = db
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES (?, ?, 'run', 'passed', ?)`,
    )
    .run(runDate, timeDir, startedAt);
  db.close();
  return Number(result.lastInsertRowid);
}

/** Seeds a raw `checkpoints` row for (runDate, timeDir, stage) with an
 * arbitrary JS value as its payload — used both for well-formed
 * `{ jobs, dropped }` payloads and for deliberately malformed/foreign ones
 * (the defensive-guard tests below). */
function insertCheckpoint(
  name: string,
  runDate: string,
  timeDir: string,
  stage: string,
  payload: unknown,
): void {
  const db = new DatabaseSync(dbPathFor(name));
  db.prepare(
    `INSERT INTO checkpoints (run_date, time_dir, position, stage, payload_json, created_at)
     VALUES (?, ?, 0, ?, ?, ?)`,
  ).run(runDate, timeDir, stage, JSON.stringify(payload), runDate);
  db.close();
}

/** Writes `config_docs.value_text` DIRECTLY (raw SQL, bypassing
 * `writeConfigDoc`'s own `validateConfigDoc` gate) — the only way to get a
 * genuinely corrupted stored doc onto disk, since every real write path
 * validates first. Mirrors `insertCheckpoint`'s own raw-seed posture above. */
function writeRawConfigDoc(name: string, key: string, valueText: string): void {
  const db = new DatabaseSync(dbPathFor(name));
  db.prepare(
    'INSERT OR REPLACE INTO config_docs (key, value_text, updated_at) VALUES (?, ?, ?)',
  ).run(key, valueText, '2026-08-01T00:00:00.000Z');
  db.close();
}

function structuredJob(id: string, company: string): unknown {
  return {
    identity: {
      id,
      lane: 'test',
      url: `https://example.com/${id}`,
      company,
      title: `Engineer ${id}`,
      scrapedAt: '2026-08-01T00:00:00.000Z',
    },
    structured: { titleParts: {}, locations: [], skills: [] },
  };
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobbunny-board-preview-wire-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('wireBoard — previewFilterRule (via board.ts delegate + real SqliteCheckpointStore)', () => {
  test('no runs at all -> available:false/no_recent_run', async () => {
    writeProfile('no-runs');
    await migrateProfile('no-runs');

    const source = wireBoard({ root });
    const result = await source.previewFilterRule('no-runs', {});
    assert.deepEqual(result, { available: false, reason: 'no_recent_run' });
    source.close();
  });

  test('runs exist but none has an assemble checkpoint -> available:false/checkpoint_expired', async () => {
    writeProfile('no-assemble');
    await migrateProfile('no-assemble');
    insertRun('no-assemble', '2026-08-01', '09-00', '2026-08-01T09:00:00.000Z');
    insertRun('no-assemble', '2026-08-02', '10-00', '2026-08-02T10:00:00.000Z');
    // A checkpoint exists, but for a different stage — never satisfies the
    // ASSEMBLE_STAGE readAt lookup.
    insertCheckpoint('no-assemble', '2026-08-02', '10-00', 'source', {
      jobs: [],
      dropped: [],
    });

    const source = wireBoard({ root });
    const result = await source.previewFilterRule('no-assemble', {});
    assert.deepEqual(result, { available: false, reason: 'checkpoint_expired' });
    source.close();
  });

  test('first-hit-wins: newest run lacks an assemble checkpoint, next-newest has one', async () => {
    writeProfile('first-hit');
    await migrateProfile('first-hit');
    // Older run — HAS an assemble checkpoint with one job.
    insertRun('first-hit', '2026-08-01', '09-00', '2026-08-01T09:00:00.000Z');
    insertCheckpoint('first-hit', '2026-08-01', '09-00', 'assemble', {
      jobs: [structuredJob('older-1', 'OlderCo')],
      dropped: [],
    });
    // Newer run — inserted second, so it has the higher id and is listed
    // first by `listRuns` (`ORDER BY runs.id DESC`) — but it has NO
    // assemble checkpoint at all, so `previewFilterRule` must fall through
    // to the older run instead of reporting `checkpoint_expired`.
    insertRun('first-hit', '2026-08-02', '10-00', '2026-08-02T10:00:00.000Z');

    const source = wireBoard({ root });
    const result = (await source.previewFilterRule('first-hit', {})) as Extract<
      FilterPreviewResult,
      { available: true }
    >;
    assert.ok(result.available, `expected available:true, got ${JSON.stringify(result)}`);
    assert.equal(result.totalJobs, 1);
    source.close();
  });

  test('a malformed checkpoint payload (missing jobs/dropped arrays) degrades to checkpoint_expired, never throws', async () => {
    writeProfile('malformed-payload');
    await migrateProfile('malformed-payload');
    insertRun('malformed-payload', '2026-08-01', '09-00', '2026-08-01T09:00:00.000Z');
    // Foreign/malformed shape — not `{ jobs: unknown[]; dropped: unknown[] }`.
    insertCheckpoint('malformed-payload', '2026-08-01', '09-00', 'assemble', {
      foo: 'bar',
    });

    const source = wireBoard({ root });
    const result = await source.previewFilterRule('malformed-payload', {});
    assert.deepEqual(result, { available: false, reason: 'checkpoint_expired' });
    source.close();
  });

  test('a payload whose jobs are entirely unstructured degrades to checkpoint_expired, never reports a preview over zero jobs', async () => {
    writeProfile('all-unstructured');
    await migrateProfile('all-unstructured');
    insertRun('all-unstructured', '2026-08-01', '09-00', '2026-08-01T09:00:00.000Z');
    insertCheckpoint('all-unstructured', '2026-08-01', '09-00', 'assemble', {
      jobs: [
        {
          identity: {
            id: '1',
            lane: 'test',
            url: 'https://x/1',
            company: 'C',
            title: 'x',
          },
        },
      ],
      dropped: [],
    });

    const source = wireBoard({ root });
    const result = await source.previewFilterRule('all-unstructured', {});
    assert.deepEqual(result, { available: false, reason: 'checkpoint_expired' });
    source.close();
  });

  test('happy path: real filter.json (via readConfigDoc) + real evaluate/decide over a real checkpoint payload', async () => {
    writeProfile('happy');
    await migrateProfile('happy');
    insertRun('happy', '2026-08-01', '09-00', '2026-08-01T09:00:00.000Z');
    insertCheckpoint('happy', '2026-08-01', '09-00', 'assemble', {
      jobs: [
        structuredJob('1', 'GoodCo'),
        structuredJob('2', 'BadCo'),
        structuredJob('3', 'BadCo'),
      ],
      dropped: [],
    });

    const source = wireBoard({ root });
    // Current filter.json has no company avoid-list.
    await source.writeConfigDoc('happy', 'filter.json', JSON.stringify({}));

    const draft = { companies: { avoid: ['BadCo'] } };
    const result = (await source.previewFilterRule('happy', draft)) as Extract<
      FilterPreviewResult,
      { available: true }
    >;
    assert.ok(result.available, `expected available:true, got ${JSON.stringify(result)}`);
    assert.equal(result.totalJobs, 3);
    assert.equal(result.baselineDrops, 0);
    assert.equal(result.draftDrops, 2);
    assert.deepEqual(
      result.newlyDropped.map((j) => j.company),
      ['BadCo', 'BadCo'],
    );
    source.close();
  });

  test("an invalid draft filter config throws InvalidDraftFilterConfigError (board.ts delegate propagates board_preview.ts's validator throw)", async () => {
    writeProfile('invalid-draft');
    await migrateProfile('invalid-draft');

    const source = wireBoard({ root });
    await assert.rejects(
      () =>
        source.previewFilterRule('invalid-draft', { skills: { core: 'not-an-array' } }),
      (err: unknown) => {
        assert.ok(isInvalidDraftFilterConfigError(err));
        assert.match((err as Error).message, /skills/);
        return true;
      },
    );
    source.close();
  });

  test('finding 1: a corrupted stored filter.json (invalid JSON) throws, but NEVER InvalidDraftFilterConfigError', async () => {
    writeProfile('corrupt-json');
    await migrateProfile('corrupt-json');
    insertRun('corrupt-json', '2026-08-01', '09-00', '2026-08-01T09:00:00.000Z');
    insertCheckpoint('corrupt-json', '2026-08-01', '09-00', 'assemble', {
      jobs: [structuredJob('1', 'GoodCo')],
      dropped: [],
    });
    writeRawConfigDoc('corrupt-json', 'filter.json', '{not valid json');

    const source = wireBoard({ root });
    await assert.rejects(
      // A VALID draft — proves the throw comes from the stored doc, not
      // from draft validation.
      () => source.previewFilterRule('corrupt-json', {}),
      (err: unknown) => {
        assert.ok(
          !isInvalidDraftFilterConfigError(err),
          `expected a data-corruption error, got ${err}`,
        );
        return true;
      },
    );
    source.close();
  });

  test('finding 1: a stored filter.json that fails FilterConfigSchema throws, but NEVER InvalidDraftFilterConfigError', async () => {
    writeProfile('corrupt-schema');
    await migrateProfile('corrupt-schema');
    insertRun('corrupt-schema', '2026-08-01', '09-00', '2026-08-01T09:00:00.000Z');
    insertCheckpoint('corrupt-schema', '2026-08-01', '09-00', 'assemble', {
      jobs: [structuredJob('1', 'GoodCo')],
      dropped: [],
    });
    // Valid JSON, but violates FilterConfigSchema (wrong type for
    // `skills.core`) — e.g. a doc written by a since-tightened schema
    // version.
    writeRawConfigDoc(
      'corrupt-schema',
      'filter.json',
      JSON.stringify({ skills: { core: 'not-an-array' } }),
    );

    const source = wireBoard({ root });
    await assert.rejects(
      () => source.previewFilterRule('corrupt-schema', {}),
      (err: unknown) => {
        assert.ok(
          !isInvalidDraftFilterConfigError(err),
          `expected a data-corruption error, got ${err}`,
        );
        return true;
      },
    );
    source.close();
  });
});
