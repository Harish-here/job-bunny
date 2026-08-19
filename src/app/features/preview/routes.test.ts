/**
 * routes.test.ts (R15) — TDD for `makePreviewRoutes`.
 *
 * `app` may never import `cli` (`nothing-imports-cli`), so this file can't
 * reach `cli/wire/board_preview.ts` — the real `previewFilterRule`
 * implementation — directly. Its fake `BoardSource.previewFilterRule`
 * below instead mirrors the CONTRACT that implementation's own doc comment
 * (`ports/board.ts`) and the task-10 brief pin: validate the draft via the
 * real `FilterConfigSchema` and throw on failure (mirroring
 * `writeConfigDoc`'s validator-throw posture), narrow raw checkpoint jobs
 * to `StructuredJD` before evaluating (dropping, never throwing on, a job
 * missing `structured`), and re-run the real `core/filter` `evaluate`/
 * `decide` twice. Reusing the real `core/filter` primitives (allowed —
 * `app-only-ports-core`) means this test exercises the exact same
 * evaluation behavior `board_preview.ts` re-runs, even though it can't
 * import that file's own orchestration code (checkpoint/run-store lookup)
 * — that part is intentionally left to code review, per the brief's own
 * "step 32's implementation has no test until step 35's route test" note.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, evaluate, FilterConfigSchema } from '../../../core/filter/index.ts';
import type { StructuredJD } from '../../../core/jd/index.ts';
import type { BoardSource, FilterPreviewResult } from '../../../ports/board.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makePreviewRoutes } from './routes.ts';

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return {
    params: { name: 'rajni' },
    query: new URLSearchParams(),
    body: {},
    ...overrides,
  };
}

function job(id: string, company: string): StructuredJD {
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

function isStructuredJD(jd: unknown): jd is StructuredJD {
  return (
    typeof jd === 'object' && jd !== null && (jd as StructuredJD).structured !== undefined
  );
}

type Mode =
  | { kind: 'no_recent_run' }
  | { kind: 'checkpoint_expired' }
  | { kind: 'evaluate'; rawJobs: unknown[] };

/** Mirrors `previewFilterRule`'s documented contract (see file header) —
 * NOT an import of the real implementation. */
function fakeSource(mode: Mode): BoardSource {
  return {
    listProfiles: async () => [{ name: 'rajni', connector: 'sqlite', hasDb: true }],
    openStore: async () => null,
    readConfigDoc: async () => JSON.stringify({}),
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    readDaemonStatus: async () => ({
      state: 'stopped',
      pid: null,
      startedAt: null,
      lastTickAt: null,
      inFlight: null,
      profiles: [],
    }),
    stopDaemon: async () => ({ outcome: 'stopped' }),
    startDaemon: async () => ({ outcome: 'started' }),
    async previewFilterRule(_name, draftFilterConfig): Promise<FilterPreviewResult> {
      const parsed = FilterConfigSchema.safeParse(draftFilterConfig);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'bad',
        );
      }
      if (mode.kind === 'no_recent_run')
        return { available: false, reason: 'no_recent_run' };
      if (mode.kind === 'checkpoint_expired') {
        return { available: false, reason: 'checkpoint_expired' };
      }
      const structuredJobs = mode.rawJobs.filter(isStructuredJD);
      if (structuredJobs.length === 0) {
        return { available: false, reason: 'checkpoint_expired' };
      }
      const currentConfig = FilterConfigSchema.parse({});
      let baselineDrops = 0;
      let draftDrops = 0;
      const newlyDropped: Array<{ title: string; company: string }> = [];
      for (const jd of structuredJobs) {
        const baseline = decide(evaluate(jd, currentConfig));
        const draft = decide(evaluate(jd, parsed.data));
        if (baseline === 'drop') baselineDrops += 1;
        if (draft === 'drop') draftDrops += 1;
        if (draft === 'drop' && baseline !== 'drop' && newlyDropped.length < 12) {
          newlyDropped.push({ title: jd.identity.title, company: jd.identity.company });
        }
      }
      return {
        available: true,
        totalJobs: structuredJobs.length,
        baselineDrops,
        draftDrops,
        newlyDropped,
      };
    },
    close: () => {},
  };
}

async function post(source: BoardSource, body: unknown) {
  const [route] = makePreviewRoutes(source);
  if (!route) throw new Error('no route registered');
  return route.handler(req({ body }));
}

test('happy path: draft drops more than baseline, newlyDropped populated', async () => {
  const rawJobs = [job('1', 'GoodCo'), job('2', 'BadCo'), job('3', 'BadCo')];
  const source = fakeSource({ kind: 'evaluate', rawJobs });
  const draft = { companies: { avoid: ['BadCo'] } };
  const res = await post(source, draft);
  assert.equal(res.status, 200);
  const body = res.body as FilterPreviewResult;
  assert.ok(body.available);
  if (!body.available) throw new Error('unreachable');
  assert.equal(body.totalJobs, 3);
  assert.equal(body.baselineDrops, 0);
  assert.equal(body.draftDrops, 2);
  assert.deepEqual(
    body.newlyDropped.map((j) => j.company),
    ['BadCo', 'BadCo'],
  );
});

test('newlyDropped is capped at 12', async () => {
  const rawJobs = Array.from({ length: 20 }, (_, i) => job(String(i), 'BadCo'));
  const source = fakeSource({ kind: 'evaluate', rawJobs });
  const res = await post(source, { companies: { avoid: ['BadCo'] } });
  const body = res.body as FilterPreviewResult;
  assert.ok(body.available);
  if (!body.available) throw new Error('unreachable');
  assert.equal(body.draftDrops, 20);
  assert.equal(body.newlyDropped.length, 12);
});

test('no run yet for the profile -> available:false/no_recent_run', async () => {
  const source = fakeSource({ kind: 'no_recent_run' });
  const res = await post(source, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { available: false, reason: 'no_recent_run' });
});

test('checkpoint pruned/missing -> available:false/checkpoint_expired', async () => {
  const source = fakeSource({ kind: 'checkpoint_expired' });
  const res = await post(source, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { available: false, reason: 'checkpoint_expired' });
});

test('malformed draft body -> HTTP 422 naming the offending field', async () => {
  const source = fakeSource({ kind: 'no_recent_run' });
  await assert.rejects(
    async () => post(source, { skills: { core: 'not-an-array' } }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 422);
      assert.equal(err.code, 'validation');
      assert.match(err.message, /skills/);
      return true;
    },
  );
});

test('one job with no structured slice is silently dropped from the count, not a 500', async () => {
  const rawJobs: unknown[] = [
    job('1', 'BadCo'),
    {
      identity: {
        id: '2',
        lane: 'test',
        url: 'https://x/2',
        company: 'BadCo',
        title: 'x',
      },
    },
  ];
  const source = fakeSource({ kind: 'evaluate', rawJobs });
  const res = await post(source, { companies: { avoid: ['BadCo'] } });
  assert.equal(res.status, 200);
  const body = res.body as FilterPreviewResult;
  assert.ok(body.available);
  if (!body.available) throw new Error('unreachable');
  assert.equal(body.totalJobs, 1);
  assert.equal(body.draftDrops, 1);
});

test('a payload that is entirely unstructured degrades to checkpoint_expired', async () => {
  const rawJobs: unknown[] = [
    {
      identity: {
        id: '1',
        lane: 'test',
        url: 'https://x/1',
        company: 'BadCo',
        title: 'x',
      },
    },
  ];
  const source = fakeSource({ kind: 'evaluate', rawJobs });
  const res = await post(source, { companies: { avoid: ['BadCo'] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { available: false, reason: 'checkpoint_expired' });
});
