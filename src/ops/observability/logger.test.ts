import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { JsonlLogger } from './logger.ts';

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
