/**
 * board.test.ts (local-DB spec PR 4, Task 8) — `boardCommand` exercised
 * entirely against fake `BoardDeps` object literals: no real `wireBoard`,
 * no real `createBoardServer`, no real socket. Ordering (`waitForStop`
 * resolves before `close()` is awaited) is asserted via a call log, not
 * timing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardServer, BoardServerOptions } from '../../app/server/index.ts';
import type { BoardProfile, BoardSource } from '../../ports/board.ts';
import { type BoardDeps, boardCommand } from './board.ts';

function fakeSource(profiles: BoardProfile[] = []): BoardSource {
  return {
    listProfiles: () => profiles,
    openStore: () => null,
    close: () => {},
  };
}

function noopLogger(): BoardDeps['logger'] {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

/** Baseline fakes every test starts from and overrides selectively. */
function baseDeps(overrides: Partial<BoardDeps> = {}): Partial<BoardDeps> {
  return {
    wireBoard: () => fakeSource(),
    createServer: (_o: BoardServerOptions): BoardServer => ({
      listen: async (port: number) => ({ port }),
      close: async () => {},
    }),
    logger: noopLogger(),
    uiDir: '/fake/ui/dist',
    version: '0.0.0-test',
    write: () => {},
    waitForStop: async () => {},
    ...overrides,
  };
}

test('boardCommand: passes opts.port through to server.listen', async () => {
  let receivedPort: number | undefined;
  const deps = baseDeps({
    createServer: () => ({
      listen: async (port: number) => {
        receivedPort = port;
        return { port };
      },
      close: async () => {},
    }),
  });
  const code = await boardCommand({ port: 4646 }, deps);
  assert.equal(code, 0);
  assert.equal(receivedPort, 4646);
});

test('boardCommand: prints the BOUND port from listen(), not the requested port', async () => {
  const out = collector();
  const deps = baseDeps({
    createServer: () => ({
      listen: async () => ({ port: 51234 }),
      close: async () => {},
    }),
    write: out.write,
  });
  const code = await boardCommand({ port: 0 }, deps);
  assert.equal(code, 0);
  assert.ok(
    out.lines.includes('board: http://127.0.0.1:51234'),
    `expected bound port 51234 in output, got: ${out.lines.join(' | ')}`,
  );
  assert.ok(
    !out.lines.some((l) => l.includes(':0')),
    'must not print the requested port',
  );
});

test('boardCommand: prints one line per profile, local-db vs notion-only', async () => {
  const out = collector();
  const deps = baseDeps({
    wireBoard: () =>
      fakeSource([
        { name: 'rajni', connector: 'sqlite', hasDb: true },
        { name: 'harish', connector: 'notion', hasDb: false },
      ]),
    write: out.write,
  });
  const code = await boardCommand({ port: 4646 }, deps);
  assert.equal(code, 0);
  assert.ok(out.lines.includes('rajni — local db'));
  assert.ok(out.lines.includes('harish — notion-only'));
});

test('boardCommand: labels by connector, not hasDb — a notion profile with a jobbunny.db file (local-DB spec D5: unconditional run-history tracking) is still "notion-only"', async () => {
  const out = collector();
  const deps = baseDeps({
    wireBoard: () => fakeSource([{ name: 'harish', connector: 'notion', hasDb: true }]),
    write: out.write,
  });
  const code = await boardCommand({ port: 4646 }, deps);
  assert.equal(code, 0);
  assert.ok(out.lines.includes('harish — notion-only'));
});

test('boardCommand: resolves 0 only after waitForStop() resolves, and awaits server.close() after that', async () => {
  const calls: string[] = [];
  let resolveWait: () => void = () => {};
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const deps = baseDeps({
    createServer: () => ({
      listen: async (port: number) => ({ port }),
      close: async () => {
        calls.push('close');
      },
    }),
    waitForStop: () => {
      calls.push('waitForStop:called');
      return waitPromise;
    },
  });

  const pending = boardCommand({ port: 4646 }, deps);
  // Let microtasks flush without resolving waitForStop yet.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    calls,
    ['waitForStop:called'],
    'close must not run before waitForStop resolves',
  );

  resolveWait();
  const code = await pending;
  assert.equal(code, 0);
  assert.deepEqual(calls, ['waitForStop:called', 'close']);
});

test('boardCommand: a wireBoard construction error propagates (not swallowed)', async () => {
  const deps = baseDeps({
    wireBoard: () => {
      throw new Error('boom: bad root');
    },
  });
  await assert.rejects(boardCommand({ port: 4646 }, deps), /boom: bad root/);
});

test('boardCommand: a createServer/listen error propagates (not swallowed)', async () => {
  const deps = baseDeps({
    createServer: () => ({
      listen: async () => {
        throw new Error('EADDRINUSE');
      },
      close: async () => {},
    }),
  });
  await assert.rejects(boardCommand({ port: 4646 }, deps), /EADDRINUSE/);
});
