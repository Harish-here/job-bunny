import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmProvider, Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { TABLE_PATH } from './compress.ts';
import {
  BATCH_SIZE,
  DECISIONS_PARTIAL_PATH,
  DECISIONS_PATH,
  makeStructureStage,
} from './structure.ts';

function fakeStorage(): Storage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async readJson<T>(relPath: string, schema: { parse(v: unknown): T }) {
      if (!store.has(relPath)) return undefined;
      return schema.parse(store.get(relPath));
    },
    async writeJson(relPath: string, value: unknown) {
      store.set(relPath, value);
    },
  };
}

function fakeCtx(
  storage: ReturnType<typeof fakeStorage>,
  overrides?: { signal?: AbortSignal; beat?: () => void },
): StageContext {
  return {
    profile: 'rajni',
    signal: overrides?.signal ?? AbortSignal.timeout(30_000),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    beat: overrides?.beat ?? (() => {}),
    storage,
  };
}

function decisionRow(id: string): string {
  return `| ${id} | Frontend | Senior | React | Bengaluru | India | onsite |  | React; TypeScript |  |`;
}

function inputTableFor(ids: string[]): string {
  const rows = ids.map(
    (id) => `| ${id} | Frontend Engineer | Acme Corp | We build things. |`,
  );
  return `| id | title | company | rawText |\n|---|---|---|---|\n${rows.join('\n')}`;
}

function emptyPayload(): StagePayload {
  return { jobs: [], dropped: [] };
}

/** LlmProvider whose `complete` records every prompt it was called with and
 * returns a canned decisions table built from whatever ids appear in the
 * prompt's row lines — a close-enough fake for exercising the stage's
 * batching/checkpoint/resume logic without a real model. */
function makeFakeLlm(opts?: {
  onComplete?: (prompt: string) => void;
  throwOn?: number; // 1-indexed call number to throw on
}): LlmProvider & { prompts: string[] } {
  const prompts: string[] = [];
  let callCount = 0;
  return {
    name: 'fake',
    prompts,
    async complete(prompt: string) {
      callCount += 1;
      prompts.push(prompt);
      opts?.onComplete?.(prompt);
      if (opts?.throwOn === callCount) {
        throw new Error(`fake llm boom on call ${callCount}`);
      }
      const ids = [...prompt.matchAll(/^\| (\S+) \| Frontend Engineer \|/gm)].map(
        (m) => m[1] as string,
      );
      const rows = ids.map((id) => decisionRow(id));
      return `| id | domain | seniority | func | city | country | workType | timezone | skills | salary |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}`;
    },
  };
}

test('StageDef declares heartbeat: true and retries: 1', () => {
  const stage = makeStructureStage(makeFakeLlm());
  assert.equal(stage.heartbeat, true);
  assert.equal(stage.retries, 1);
  assert.equal(stage.name, 'structure');
});

test('batches 60 input rows into exactly 3 LLM calls of 25/25/10', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `li-${i + 1}`);
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  const llm = makeFakeLlm();
  const stage = makeStructureStage(llm);
  const ctx = fakeCtx(storage);

  await stage.run(emptyPayload(), ctx);

  assert.equal(llm.prompts.length, 3);

  const idsInPrompt = (prompt: string) =>
    [...prompt.matchAll(/^\| (li-\d+) \| Frontend Engineer \|/gm)].map((m) => m[1]);

  assert.equal(idsInPrompt(llm.prompts[0] as string).length, BATCH_SIZE);
  assert.equal(idsInPrompt(llm.prompts[1] as string).length, BATCH_SIZE);
  assert.equal(idsInPrompt(llm.prompts[2] as string).length, 10);

  // Batch boundaries: first batch is li-1..li-25, second li-26..li-50, third li-51..li-60.
  assert.deepEqual(idsInPrompt(llm.prompts[0] as string), ids.slice(0, 25));
  assert.deepEqual(idsInPrompt(llm.prompts[1] as string), ids.slice(25, 50));
  assert.deepEqual(idsInPrompt(llm.prompts[2] as string), ids.slice(50, 60));
});

test('checkpoint is written after each batch (partial grows monotonically)', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `li-${i + 1}`);
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  const partialSnapshotsAfterEachCall: number[] = [];
  const llm = makeFakeLlm({
    onComplete: () => {
      // Snapshot the partial checkpoint's row count as of just before this
      // call resolves and the stage writes the next checkpoint — i.e. this
      // captures state left by the PREVIOUS batch's write.
      const partial = storage.store.get(DECISIONS_PARTIAL_PATH) as string | undefined;
      const rowCount = partial ? partial.split('\n').length - 2 : 0;
      partialSnapshotsAfterEachCall.push(Math.max(rowCount, 0));
    },
  });

  const stage = makeStructureStage(llm);
  const ctx = fakeCtx(storage);
  await stage.run(emptyPayload(), ctx);

  // Before call 1: nothing checkpointed yet (0 rows).
  // Before call 2: batch 1 (25 rows) checkpointed.
  // Before call 3: batch 1+2 (50 rows) checkpointed.
  assert.deepEqual(partialSnapshotsAfterEachCall, [0, 25, 50]);

  // After the run completes successfully, the partial is cleared back to
  // header+separator only (0 data rows) — see structure.ts's post-success
  // reset — while decisions.json holds the full 60-row table.
  const finalPartial = storage.store.get(DECISIONS_PARTIAL_PATH) as string;
  assert.equal(finalPartial.split('\n').length, 2);

  const final = storage.store.get(DECISIONS_PATH) as string;
  assert.equal(final.split('\n').length - 2, 60);
});

test('resume: pre-seeded partial with some done ids skips those rows, only remaining sent', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `li-${i + 1}`);
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  const doneIds = ['li-1', 'li-2', 'li-3'];
  const doneRows = doneIds.map((id) => decisionRow(id)).join('\n');
  storage.store.set(
    DECISIONS_PARTIAL_PATH,
    `| id | domain | seniority | func | city | country | workType | timezone | skills | salary |\n|---|---|---|---|---|---|---|---|---|---|\n${doneRows}`,
  );

  const llm = makeFakeLlm();
  const stage = makeStructureStage(llm);
  const ctx = fakeCtx(storage);

  await stage.run(emptyPayload(), ctx);

  assert.equal(llm.prompts.length, 1);
  const idsInPrompt = [
    ...(llm.prompts[0] as string).matchAll(/^\| (li-\d+) \| Frontend Engineer \|/gm),
  ].map((m) => m[1]);
  assert.deepEqual(idsInPrompt, [
    'li-4',
    'li-5',
    'li-6',
    'li-7',
    'li-8',
    'li-9',
    'li-10',
  ]);

  const final = storage.store.get(DECISIONS_PATH) as string;
  for (const id of ids) {
    assert.ok(final.includes(id), `expected final decisions to include ${id}`);
  }
});

test('resume: all input ids already done in the partial -> zero LLM calls', async () => {
  const ids = ['li-1', 'li-2'];
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  const doneRows = ids.map((id) => decisionRow(id)).join('\n');
  storage.store.set(
    DECISIONS_PARTIAL_PATH,
    `| id | domain | seniority | func | city | country | workType | timezone | skills | salary |\n|---|---|---|---|---|---|---|---|---|---|\n${doneRows}`,
  );

  const llm = makeFakeLlm();
  const stage = makeStructureStage(llm);
  const ctx = fakeCtx(storage);

  const out = await stage.run(emptyPayload(), ctx);

  assert.equal(llm.prompts.length, 0);
  assert.deepEqual(out, emptyPayload());

  const final = storage.store.get(DECISIONS_PATH) as string;
  assert.ok(final.includes('li-1'));
  assert.ok(final.includes('li-2'));
});

test('a provider throw is loud: run() rejects and does not mask the failure as partial success', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `li-${i + 1}`);
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  const llm = makeFakeLlm({ throwOn: 2 }); // second batch (li-26..li-30) throws
  const stage = makeStructureStage(llm);
  const ctx = fakeCtx(storage);

  await assert.rejects(() => stage.run(emptyPayload(), ctx), /fake llm boom on call 2/);

  // First batch's checkpoint survived (loud failure ≠ silent data loss);
  // decisions.json (the "done" signal for assemble) was never written.
  const partial = storage.store.get(DECISIONS_PARTIAL_PATH) as string;
  assert.equal(partial.split('\n').length - 2, 25);
  assert.equal(storage.store.has(DECISIONS_PATH), false);
});

test('a retried run (simulating the runner re-invoking run() per guardStage retries:1) resumes from the surviving checkpoint and only re-sends the failed batch', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `li-${i + 1}`);
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  const failingLlm = makeFakeLlm({ throwOn: 2 });
  const failingStage = makeStructureStage(failingLlm);
  const ctx = fakeCtx(storage);
  await assert.rejects(() => failingStage.run(emptyPayload(), ctx));

  // Simulate the runner's retry: a fresh stage instance (fresh provider),
  // same storage/ctx, run() invoked again.
  const retryLlm = makeFakeLlm();
  const retryStage = makeStructureStage(retryLlm);
  await retryStage.run(emptyPayload(), ctx);

  assert.equal(retryLlm.prompts.length, 1);
  const idsInPrompt = [
    ...(retryLlm.prompts[0] as string).matchAll(/^\| (li-\d+) \| Frontend Engineer \|/gm),
  ].map((m) => m[1]);
  assert.deepEqual(idsInPrompt, ids.slice(25, 30));

  const final = storage.store.get(DECISIONS_PATH) as string;
  for (const id of ids) {
    assert.ok(final.includes(id));
  }
});

test('final decisions persisted to DECISIONS_PATH on success, payload threaded through unchanged', async () => {
  const ids = ['li-1', 'li-2'];
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  const stage = makeStructureStage(makeFakeLlm());
  const ctx = fakeCtx(storage);
  const input = emptyPayload();

  const out = await stage.run(input, ctx);

  assert.equal(out, input);
  const final = storage.store.get(DECISIONS_PATH) as string;
  assert.ok(final.startsWith('| id | domain | seniority | func |'));
  assert.ok(final.includes('li-1'));
  assert.ok(final.includes('li-2'));
});

test('run() fails loud when the input table is missing (structure run before compress)', async () => {
  const storage = fakeStorage();
  const stage = makeStructureStage(makeFakeLlm());
  const ctx = fakeCtx(storage);

  await assert.rejects(() => stage.run(emptyPayload(), ctx), /no input table/);
});

test('signal is passed through to llm.complete', async () => {
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(['li-1']));

  let capturedSignal: AbortSignal | undefined;
  const llm: LlmProvider = {
    name: 'fake',
    async complete(_prompt, opts) {
      capturedSignal = opts.signal;
      return decisionRow('li-1');
    },
  };

  const stage = makeStructureStage(llm);
  const controller = new AbortController();
  const ctx = fakeCtx(storage, { signal: controller.signal });
  await stage.run(emptyPayload(), ctx);

  assert.equal(capturedSignal, controller.signal);
});

test('heartbeat: ctx.beat() is called after each batch', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `li-${i + 1}`);
  const storage = fakeStorage();
  storage.store.set(TABLE_PATH, inputTableFor(ids));

  let beats = 0;
  const stage = makeStructureStage(makeFakeLlm());
  const ctx = fakeCtx(storage, { beat: () => (beats += 1) });
  await stage.run(emptyPayload(), ctx);

  assert.equal(beats, 2); // 2 batches (25 + 5)
});
