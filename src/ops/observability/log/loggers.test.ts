import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Logger, RunEventRow, RunStoreWriter } from '../../../ports/index.ts';
import {
  ConsoleLogger,
  isLogLevel,
  JsonlLogger,
  LOG_LEVELS,
  RunStoreLogger,
  shouldLog,
  withScope,
} from './loggers.ts';

/** Minimal fake `RunStoreWriter` — only `appendEvents` is exercised by
 * `RunStoreLogger`; the rest throw if a future change starts calling them
 * unexpectedly, so a silent behavior drift would fail loudly here. */
function fakeStore(): RunStoreWriter & {
  calls: Array<{ runId: number; events: RunEventRow[] }>;
} {
  const calls: Array<{ runId: number; events: RunEventRow[] }> = [];
  return {
    calls,
    startRun: () => {
      throw new Error('unexpected startRun call');
    },
    appendEvents: (runId, events) => {
      calls.push({ runId, events });
    },
    heartbeat: () => {
      throw new Error('unexpected heartbeat call');
    },
    recordFailure: () => {
      throw new Error('unexpected recordFailure call');
    },
    recordSyncDryrun: () => {
      throw new Error('unexpected recordSyncDryrun call');
    },
    finishRun: () => {
      throw new Error('unexpected finishRun call');
    },
  };
}

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-logger-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('appends {ts, level, msg, data} JSON lines to the log file', async () => {
  const filePath = join(root, 'nested', 'run.log');
  const logger = new JsonlLogger(filePath);
  logger.info('starting stage', { stage: 'farm' });
  logger.warn('slow response');
  logger.error('boom', { code: 'ETIMEDOUT' });
  await logger.flush();

  const raw = await readFile(filePath, 'utf8');
  const lines = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].msg, 'starting stage');
  assert.deepEqual(lines[0].data, { stage: 'farm' });
  assert.equal(typeof lines[0].ts, 'string');
  assert.equal(lines[1].level, 'warn');
  assert.equal(lines[2].level, 'error');
  assert.deepEqual(lines[2].data, { code: 'ETIMEDOUT' });
});

test('debug level is written too', async () => {
  const filePath = join(root, 'debug.log');
  const logger = new JsonlLogger(filePath);
  logger.debug('detail', undefined);
  await logger.flush();
  const raw = await readFile(filePath, 'utf8');
  const line = JSON.parse(raw.trim());
  assert.equal(line.level, 'debug');
  assert.equal(line.msg, 'detail');
});

test('mirrors to stdout only when process.stdout.isTTY is true', async () => {
  const filePath = join(root, 'tty.log');
  const logger = new JsonlLogger(filePath);
  const originalIsTTY = process.stdout.isTTY;
  const originalLog = console.log;
  const written: string[] = [];
  console.log = (...args: unknown[]) => {
    written.push(String(args[0]));
  };

  try {
    process.stdout.isTTY = false;
    logger.info('silent');
    await logger.flush();
    assert.equal(written.length, 0);

    process.stdout.isTTY = true;
    logger.info('loud');
    await logger.flush();
    assert.equal(written.length, 1);
    assert.match(written[0] ?? '', /"msg":"loud"/);
  } finally {
    console.log = originalLog;
    process.stdout.isTTY = originalIsTTY;
  }
});

test('LOG_LEVELS / isLogLevel: narrows valid level strings, rejects everything else', () => {
  assert.deepEqual(LOG_LEVELS, ['debug', 'info', 'warn', 'error']);
  assert.equal(isLogLevel('info'), true);
  assert.equal(isLogLevel('error'), true);
  assert.equal(isLogLevel('loud'), false);
  assert.equal(isLogLevel(42), false);
  assert.equal(isLogLevel(undefined), false);
});

test('shouldLog: only levels at or above the threshold pass', () => {
  assert.equal(shouldLog('info', 'debug'), false);
  assert.equal(shouldLog('info', 'info'), true);
  assert.equal(shouldLog('info', 'warn'), true);
  assert.equal(shouldLog('info', 'error'), true);
  assert.equal(shouldLog('error', 'warn'), false);
  assert.equal(shouldLog('debug', 'debug'), true);
});

test('no-options constructor keeps write-everything-to-file, TTY-gated-mirror defaults', async () => {
  const filePath = join(root, 'defaults.log');
  const logger = new JsonlLogger(filePath, { isTTY: () => true });
  const originalLog = console.log;
  const written: string[] = [];
  console.log = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    logger.debug('detail');
    await logger.flush();
  } finally {
    console.log = originalLog;
  }
  assert.equal(written.length, 1);
  const raw = await readFile(filePath, 'utf8');
  const line = JSON.parse(raw.trim());
  assert.equal(line.level, 'debug');
});

test('fileLevel filters below-threshold levels out of the file sink', async () => {
  const filePath = join(root, 'filelevel.log');
  const logger = new JsonlLogger(filePath, { fileLevel: 'info' });
  logger.debug('should not land');
  logger.info('should land');
  await logger.flush();
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /"msg":"should land"/);
});

test('ttyLevel filters the stdout mirror independently of fileLevel', async () => {
  const filePath = join(root, 'ttylevel.log');
  const logger = new JsonlLogger(filePath, { ttyLevel: 'warn', isTTY: () => true });
  const originalLog = console.log;
  const written: string[] = [];
  console.log = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    logger.debug('quiet');
    logger.info('quiet too');
    logger.warn('loud');
    logger.error('loudest');
    await logger.flush();
  } finally {
    console.log = originalLog;
  }
  assert.equal(written.length, 2);
  assert.match(written[0] ?? '', /"msg":"loud"/);
  assert.match(written[1] ?? '', /"msg":"loudest"/);
  // file sink defaults to fileLevel 'debug' — unaffected by ttyLevel
  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.trim().split('\n').length, 4);
});

test('ConsoleLogger writes shape-identical {ts,level,msg,data} NDJSON to an injected write', () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ write: (l) => lines.push(l) });
  logger.info('hello', { a: 1 });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] as string);
  assert.deepEqual(Object.keys(parsed), ['ts', 'level', 'msg', 'data']);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'hello');
  assert.deepEqual(parsed.data, { a: 1 });
});

test('ConsoleLogger defaults to writing via console.error (stderr)', () => {
  const originalError = console.error;
  const written: string[] = [];
  console.error = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    const logger = new ConsoleLogger();
    logger.warn('careful');
  } finally {
    console.error = originalError;
  }
  assert.equal(written.length, 1);
  assert.match(written[0] ?? '', /"msg":"careful"/);
});

test('ConsoleLogger respects its level threshold', () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ level: 'warn', write: (l) => lines.push(l) });
  logger.debug('quiet');
  logger.info('quiet too');
  logger.warn('loud');
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /"msg":"loud"/);
});

test('withScope merges {scope} into every logged line data, keying alongside caller data', () => {
  const calls: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const base: Logger = {
    debug: (msg, data) => calls.push({ msg, data }),
    info: (msg, data) => calls.push({ msg, data }),
    warn: (msg, data) => calls.push({ msg, data }),
    error: (msg, data) => calls.push({ msg, data }),
  };
  const scoped = withScope(base, 'farm');
  scoped.info('hi', { a: 1 });
  assert.deepEqual(calls, [{ msg: 'hi', data: { a: 1, scope: 'farm' } }]);
});

test('withScope: scope rides alone in data when no data was passed', () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const base: Logger = {
    debug: (_msg, data) => calls.push(data),
    info: (_msg, data) => calls.push(data),
    warn: (_msg, data) => calls.push(data),
    error: (_msg, data) => calls.push(data),
  };
  const scoped = withScope(base, 'source');
  scoped.debug('no data here');
  assert.deepEqual(calls, [{ scope: 'source' }]);
});

test('withScope delegates all four Logger methods to the base', () => {
  const calls: string[] = [];
  const base: Logger = {
    debug: () => calls.push('debug'),
    info: () => calls.push('info'),
    warn: () => calls.push('warn'),
    error: () => calls.push('error'),
  };
  const scoped = withScope(base, 'x');
  scoped.debug('a');
  scoped.info('b');
  scoped.warn('c');
  scoped.error('d');
  assert.deepEqual(calls, ['debug', 'info', 'warn', 'error']);
});

test('withScope nesting composes "outer.inner" and delegates straight to the innermost base (M8)', () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const base: Logger = {
    debug: () => {},
    info: (_msg, data) => calls.push(data),
    warn: () => {},
    error: () => {},
  };
  const nested = withScope(withScope(base, 'farm'), 'linkedin');
  nested.info('hi');
  assert.deepEqual(calls, [{ scope: 'farm.linkedin' }]);
});

// --- RunStoreLogger ---

test('RunStoreLogger: buffers lines and calls store.appendEvents only on flush()', () => {
  const store = fakeStore();
  const logger = new RunStoreLogger(store, 7);
  logger.info('one');
  logger.info('two');
  logger.info('three');
  assert.equal(store.calls.length, 0);

  logger.flush();
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.runId, 7);
  assert.equal(store.calls[0]?.events.length, 3);
  assert.equal(store.calls[0]?.events[0]?.msg, 'one');
  assert.equal(store.calls[0]?.events[2]?.msg, 'three');
});

test('RunStoreLogger: flush() with an empty buffer is a no-op (no appendEvents call)', () => {
  const store = fakeStore();
  const logger = new RunStoreLogger(store, 1);
  logger.flush();
  assert.equal(store.calls.length, 0);
});

test('RunStoreLogger: an error-level line flushes immediately, without waiting for flush()', () => {
  const store = fakeStore();
  const logger = new RunStoreLogger(store, 1);
  logger.info('queued');
  logger.error('boom');
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.events.length, 2);
  assert.equal(store.calls[0]?.events[1]?.level, 'error');
});

test('RunStoreLogger: a buffer reaching 200 lines flushes immediately', () => {
  const store = fakeStore();
  const logger = new RunStoreLogger(store, 1);
  for (let i = 0; i < 199; i++) logger.info(`line-${i}`);
  assert.equal(store.calls.length, 0);
  logger.info('line-199');
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.events.length, 200);
});

test('RunStoreLogger: a coalescing timer flushes the buffer without an explicit flush() call', async () => {
  const store = fakeStore();
  const logger = new RunStoreLogger(store, 1, { flushMs: 5 });
  logger.info('queued');
  assert.equal(store.calls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.events.length, 1);
});

test('RunStoreLogger: fileLevel filters below-threshold levels out of the buffer', () => {
  const store = fakeStore();
  const logger = new RunStoreLogger(store, 1, { fileLevel: 'warn' });
  logger.debug('should not buffer');
  logger.info('should not buffer either');
  logger.warn('should buffer');
  logger.flush();
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.events.length, 1);
  assert.equal(store.calls[0]?.events[0]?.msg, 'should buffer');
});

test('RunStoreLogger: ttyLevel filters the stdout mirror independently of fileLevel (isTTY injected)', () => {
  const store = fakeStore();
  const originalLog = console.log;
  const written: string[] = [];
  console.log = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    const logger = new RunStoreLogger(store, 1, { ttyLevel: 'warn', isTTY: () => true });
    logger.debug('quiet');
    logger.info('quiet too');
    logger.warn('loud');
    logger.error('loudest');
  } finally {
    console.log = originalLog;
  }
  assert.equal(written.length, 2);
  assert.match(written[0] ?? '', /"msg":"loud"/);
  assert.match(written[1] ?? '', /"msg":"loudest"/);
});

test('RunStoreLogger: mirrors to stdout only when isTTY() returns true', () => {
  const store = fakeStore();
  const originalLog = console.log;
  const written: string[] = [];
  console.log = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    const logger = new RunStoreLogger(store, 1, { isTTY: () => false });
    logger.info('silent');
  } finally {
    console.log = originalLog;
  }
  assert.equal(written.length, 0);
});
