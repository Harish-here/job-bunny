/**
 * commands/board.ts (local-DB spec PR 4, Task 8) — `jobbunny board`: the
 * profile-less local job-board server. This file is the ONE legal
 * `cli → app` edge (`only-cli-imports-app`/`nothing-imports-cli` in
 * `.dependency-cruiser.cjs`): it imports `createBoardServer` from
 * `src/app/server/index.ts` directly, the only place in the codebase
 * allowed to.
 *
 * `wireBoard` (`cli/wire/index.ts` → `cli/wire/board.ts`, the board's own
 * composition point) is injected the same way `migrateCommand` injects
 * `wireMigrate` — real by default, a fake `BoardSource` in tests. No
 * `src/adapters/**` import here.
 *
 * Flow: wire → createServer → `listen(opts.port)` → print the URL (the
 * BOUND port from `listen()`'s return, never the requested `opts.port` —
 * `--port 0` must report the real ephemeral port the OS assigned) and one
 * line per discovered profile → `await waitForStop()` (blocks until
 * SIGINT/SIGTERM by default) → `await server.close()` → return 0.
 * Construction/listen errors are never caught here — they propagate to
 * `main.ts`'s catch, which prints and returns exit code 1, the same
 * posture every other command takes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type BoardServer,
  type BoardServerOptions,
  createBoardServer,
} from '../../app/server/index.ts';
import { createWireLogger } from '../../ops/observability/index.ts';
import type { BoardSource } from '../../ports/board.ts';
import type { Logger } from '../../ports/context.ts';
import { wireBoard as defaultWireBoard } from '../wire/index.ts';

export interface BoardCommandOptions {
  port: number;
}

export interface BoardDeps {
  wireBoard: () => BoardSource;
  createServer: (o: BoardServerOptions) => BoardServer;
  logger: Logger;
  /** Absolute path to `ui/dist`. Default: resolved from this file's own
   * location, i.e. `<repo>/ui/dist` — a missing directory is fine, the
   * server falls back to its no-UI page (`app/server/static.ts`). */
  uiDir: string;
  /** Running server version, surfaced by `GET /api/app`. Default: the root
   * package.json's `version` — a dep so tests need no disk read. */
  version: string;
  write: (line: string) => void;
  /** Resolves when the server should stop. Default: resolves on the first
   * SIGINT or SIGTERM. */
  waitForStop: () => Promise<void>;
}

function defaultWaitForStop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => resolve();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

function defaultDeps(): BoardDeps {
  return {
    wireBoard: () => defaultWireBoard(),
    createServer: (o) => createBoardServer(o),
    logger: createWireLogger(),
    uiDir: fileURLToPath(new URL('../../../ui/dist', import.meta.url)),
    version: (
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL('../../../package.json', import.meta.url)),
          'utf8',
        ),
      ) as { version: string }
    ).version,
    write: (line: string) => console.log(line),
    waitForStop: defaultWaitForStop,
  };
}

export async function boardCommand(
  opts: BoardCommandOptions,
  deps: Partial<BoardDeps> = {},
): Promise<number> {
  const resolved: BoardDeps = { ...defaultDeps(), ...deps };
  const source = resolved.wireBoard();
  const server = resolved.createServer({
    source,
    logger: resolved.logger,
    uiDir: resolved.uiDir,
    version: resolved.version,
  });

  const { port } = await server.listen(opts.port);
  resolved.write(`board: http://127.0.0.1:${port}`);
  for (const profile of source.listProfiles()) {
    // Label by `connector`, not `hasDb`: a `jobbunny.db` file exists for
    // every profile once it has run at least once (local-DB spec D5's
    // unconditional run-history tracking), so `hasDb` alone no longer
    // implies "this profile's jobs live locally" — `connector === 'sqlite'`
    // is the only thing that does (see `ports/board.ts`'s `BoardProfile`).
    resolved.write(
      `${profile.name} — ${profile.connector === 'sqlite' ? 'local db' : 'notion-only'}`,
    );
  }

  await resolved.waitForStop();
  await server.close();
  return 0;
}
