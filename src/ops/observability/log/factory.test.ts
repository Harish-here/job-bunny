import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  createDaemonLogger,
  createRunLogger,
  createWireLogger,
  LoggingSettingsSchema,
} from './factory.ts';
import { JsonlLogger } from './loggers.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-factory-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

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

test('createRunLogger: returns a JsonlLogger at the given path with cfg thresholds applied', async () => {
  const filePath = join(root, 'run.log');
  const logger = createRunLogger(filePath, { fileLevel: 'info', ttyLevel: 'warn' });
  assert.ok(logger instanceof JsonlLogger);
  assert.equal(logger.filePath, filePath);
  logger.debug('should be filtered out of the file');
  logger.info('should land');
  await logger.flush();
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /"msg":"should land"/);
});

test('createRunLogger: defaults to {fileLevel: debug, ttyLevel: debug} when cfg is absent', async () => {
  const filePath = join(root, 'run-default.log');
  const logger = createRunLogger(filePath);
  logger.debug('detail');
  await logger.flush();
  const raw = await readFile(filePath, 'utf8');
  const line = JSON.parse(raw.trim());
  assert.equal(line.level, 'debug');
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
