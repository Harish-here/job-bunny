import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunEventRow, RunStoreWriter } from '../../../ports/index.ts';
import {
  createDaemonLogger,
  createRunLogger,
  createWireLogger,
  LoggingSettingsSchema,
} from './factory.ts';
import { RunStoreLogger } from './loggers.ts';

/** Minimal fake `RunStoreWriter` — only `appendEvents` matters here. */
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

// --- LoggingSettingsSchema ---

test('LoggingSettingsSchema: an empty object defaults to fileLevel debug, ttyLevel info', () => {
  // The schema itself only accepts an object shape — callers (e.g.
  // resolveLoggingSettings) are responsible for the `settings ?? {}`
  // coercion, same posture as LinkedinPacingSettingsSchema.
  assert.deepEqual(LoggingSettingsSchema.parse({}), {
    fileLevel: 'debug',
    ttyLevel: 'info',
  });
});

test('LoggingSettingsSchema: a present-but-invalid level throws (fail loud)', () => {
  assert.throws(() => LoggingSettingsSchema.parse({ ttyLevel: 'loud' }));
  assert.throws(() => LoggingSettingsSchema.parse({ fileLevel: 'quiet' }));
});

// --- createRunLogger ---

test('createRunLogger: returns a RunStoreLogger bound to the given store/runId with cfg thresholds applied', () => {
  const store = fakeStore();
  const logger = createRunLogger(store, 42, { fileLevel: 'info', ttyLevel: 'warn' });
  assert.ok(logger instanceof RunStoreLogger);
  logger.debug('should be filtered out of the buffer');
  logger.info('should land');
  logger.flush();
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.runId, 42);
  assert.equal(store.calls[0]?.events.length, 1);
  assert.equal(store.calls[0]?.events[0]?.msg, 'should land');
});

test('createRunLogger: defaults to {fileLevel: debug, ttyLevel: debug} when cfg is absent', () => {
  const store = fakeStore();
  const logger = createRunLogger(store, 1);
  logger.debug('detail');
  logger.flush();
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0]?.events[0]?.level, 'debug');
});

test('createRunLogger: a debug line never buffers when fileLevel is warn', () => {
  const store = fakeStore();
  const logger = createRunLogger(store, 1, { fileLevel: 'warn', ttyLevel: 'debug' });
  logger.debug('should never buffer');
  logger.flush();
  assert.equal(store.calls.length, 0);
});

// --- createWireLogger ---

test('createWireLogger: emits NDJSON via console.error, defaulting to ttyLevel info', () => {
  const originalError = console.error;
  const written: string[] = [];
  console.error = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    const logger = createWireLogger();
    logger.debug('quiet');
    logger.info('loud enough', { a: 1 });
  } finally {
    console.error = originalError;
  }
  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0] as string);
  assert.deepEqual(Object.keys(parsed), ['ts', 'level', 'msg', 'data']);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'loud enough');
  assert.deepEqual(parsed.data, { a: 1 });
});

test('createWireLogger: honors a configured ttyLevel', () => {
  const originalError = console.error;
  const written: string[] = [];
  console.error = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    const logger = createWireLogger({ ttyLevel: 'error' });
    logger.warn('not loud enough');
    logger.error('boom');
  } finally {
    console.error = originalError;
  }
  assert.equal(written.length, 1);
  assert.match(written[0] as string, /"msg":"boom"/);
});

// --- createDaemonLogger ---

test('createDaemonLogger: emits {ts,level,msg,data} via console.log', () => {
  const originalLog = console.log;
  const written: string[] = [];
  console.log = (...args: unknown[]) => {
    written.push(String(args[0]));
  };
  try {
    const logger = createDaemonLogger();
    logger.info('spawn', { profile: 'rajni' });
  } finally {
    console.log = originalLog;
  }
  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0] as string);
  assert.deepEqual(Object.keys(parsed), ['ts', 'level', 'msg', 'data']);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'spawn');
  assert.deepEqual(parsed.data, { profile: 'rajni' });
});
