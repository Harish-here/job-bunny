import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUserDataDir, readBrowserUserDataDir } from './browser_dir.ts';

const signal = new AbortController().signal;

test('parseUserDataDir: value runs to the next " --"', () => {
  assert.equal(
    parseUserDataDir(
      '/Applications/Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/x --no-first-run',
    ),
    '/tmp/x',
  );
});

test('parseUserDataDir: value may contain spaces and run to end', () => {
  assert.equal(
    parseUserDataDir(
      'chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome',
    ),
    '/Users/me/Library/Application Support/Google/Chrome',
  );
});

test('parseUserDataDir: strips surrounding quotes (double and single)', () => {
  assert.equal(parseUserDataDir('chrome --user-data-dir="/a b/c" --x'), '/a b/c');
  assert.equal(parseUserDataDir("chrome --user-data-dir='/a b/c'"), '/a b/c');
});

test('parseUserDataDir: undefined when absent or empty', () => {
  assert.equal(parseUserDataDir('chrome --foo'), undefined);
  assert.equal(parseUserDataDir('chrome --user-data-dir= --x'), undefined);
});

/** Minimal WebSocket fake: records sent frames and whether close() ran. */
class FakeWs {
  static last: FakeWs;
  url: string;
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, ((e: unknown) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeWs.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, e: unknown = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
}

test('readBrowserUserDataDir: sends SystemInfo.getInfo, parses commandLine, closes the socket', async () => {
  const p = readBrowserUserDataDir('ws://x/devtools/browser/a', signal, FakeWs as never);
  FakeWs.last.emit('open');
  assert.equal(JSON.parse(FakeWs.last.sent[0] ?? '{}').method, 'SystemInfo.getInfo');
  FakeWs.last.emit('message', {
    data: JSON.stringify({
      id: 1,
      result: { commandLine: 'chrome --user-data-dir=/d --x' },
    }),
  });
  assert.equal(await p, '/d');
  assert.equal(FakeWs.last.closed, true);
});

test('readBrowserUserDataDir: a response without commandLine resolves undefined and closes', async () => {
  const p = readBrowserUserDataDir('ws://x', signal, FakeWs as never);
  FakeWs.last.emit('message', {
    data: JSON.stringify({ id: 1, error: { code: -32000 } }),
  });
  assert.equal(await p, undefined);
  assert.equal(FakeWs.last.closed, true);
});

test('readBrowserUserDataDir: abort resolves undefined and closes the socket', async () => {
  const ac = new AbortController();
  const p = readBrowserUserDataDir('ws://x', ac.signal, FakeWs as never);
  ac.abort();
  assert.equal(await p, undefined);
  assert.equal(FakeWs.last.closed, true);
});

test('readBrowserUserDataDir: socket error resolves undefined', async () => {
  const p = readBrowserUserDataDir('ws://x', signal, FakeWs as never);
  FakeWs.last.emit('error');
  assert.equal(await p, undefined);
});
