/**
 * Reads a running Chrome's `--user-data-dir` over CDP. Opens a raw WebSocket
 * to the browser endpoint, sends `SystemInfo.getInfo` (works without
 * --enable-automation, headed and headless), and parses the flag out of
 * `result.commandLine`. Always closes the socket it opens; every failure
 * (socket error, abort/timeout, no flag) resolves undefined — never throws.
 */

/** Value after `--user-data-dir=`, up to the next ` --` or end of line (the
 * value may contain spaces), with surrounding quotes stripped. */
export function parseUserDataDir(commandLine: string): string | undefined {
  const marker = '--user-data-dir=';
  const start = commandLine.indexOf(marker);
  if (start === -1) return undefined;
  const rest = commandLine.slice(start + marker.length);
  const end = rest.indexOf(' --');
  const value = (end === -1 ? rest : rest.slice(0, end))
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
  return value === '' ? undefined : value;
}

export function readBrowserUserDataDir(
  wsUrl: string,
  signal: AbortSignal,
  ctor: typeof WebSocket = WebSocket,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let ws: WebSocket | undefined;
    let settled = false;
    const finish = (dir: string | undefined) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      try {
        ws?.close();
      } catch {
        // already closing/closed
      }
      resolve(dir);
    };
    const onAbort = () => finish(undefined);
    if (signal.aborted) return finish(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      ws = new ctor(wsUrl);
    } catch {
      return finish(undefined);
    }
    ws.addEventListener('open', () => {
      ws?.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
    });
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          id?: number;
          result?: { commandLine?: unknown };
        };
        if (msg.id !== 1) return;
        const line = msg.result?.commandLine;
        finish(typeof line === 'string' ? parseUserDataDir(line) : undefined);
      } catch {
        finish(undefined);
      }
    });
    ws.addEventListener('error', () => finish(undefined));
    ws.addEventListener('close', () => finish(undefined));
  });
}
