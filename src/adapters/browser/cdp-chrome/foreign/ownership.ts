import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readBrowserUserDataDir } from './browser_dir.ts';

/**
 * Chrome ownership proof. A Chrome answering on our CDP port is only ours
 * if it runs OUR user-data-dir — a different profile's Chrome (e.g. the
 * user's daily browser started with --remote-debugging-port) must never be
 * attached to or killed. Chrome does not write DevToolsActivePort for a
 * fixed debugging port, so identity is read from the browser itself:
 * `SystemInfo.getInfo` over the probed webSocketDebuggerUrl returns its
 * command line, whose `--user-data-dir=` must equal ours (path-resolved,
 * realpath'd, case-insensitive on win32). Anything unprovable — no ws URL,
 * socket error, timeout, no flag — is foreign.
 */

const PROOF_TIMEOUT_MS = 3000;

export interface OwnershipDeps {
  /** The probed browser's --user-data-dir, or undefined on any failure. */
  readUserDataDir(wsUrl: string, signal: AbortSignal): Promise<string | undefined>;
  /** Resolves symlinks (macOS /tmp vs /private/tmp); throws when missing. */
  realpath(path: string): string;
  platform: NodeJS.Platform;
}

export function defaultOwnershipDeps(): OwnershipDeps {
  return {
    readUserDataDir: (wsUrl, signal) => readBrowserUserDataDir(wsUrl, signal),
    realpath: (path) => realpathSync(path),
    platform: process.platform,
  };
}

export class ForeignChromeError extends Error {
  readonly port: number;
  readonly foreignDir: string | undefined;
  readonly expectedDir: string;

  constructor(port: number, foreignDir: string | undefined, expectedDir: string) {
    super(
      `Chrome on CDP port :${port} is not Job Bunny's — it runs --user-data-dir=${foreignDir ?? 'an unknown user-data-dir'} (expected ${expectedDir}). Job Bunny will not attach to or close it. Close that Chrome, then rerun.`,
    );
    this.name = 'ForeignChromeError';
    this.port = port;
    this.foreignDir = foreignDir;
    this.expectedDir = expectedDir;
  }
}

function wsUrlOf(version: unknown): string | undefined {
  if (typeof version !== 'object' || version === null) return undefined;
  const url = (version as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
  return typeof url === 'string' ? url : undefined;
}

function canonical(
  dir: string,
  deps: Pick<OwnershipDeps, 'realpath' | 'platform'>,
): string {
  const abs = resolve(dir);
  let real: string;
  try {
    real = deps.realpath(abs);
  } catch {
    real = abs;
  }
  return deps.platform === 'win32' ? real.toLowerCase() : real;
}

/** Throws ForeignChromeError unless the Chrome that produced `version` is
 * proven to run `userDataDir`. The probe is bounded by `signal` plus 3s;
 * the dir it read (if any) names the foreign Chrome in the error. */
export async function assertOurChrome(opts: {
  version: unknown;
  port: number;
  userDataDir: string;
  signal: AbortSignal;
  deps: OwnershipDeps;
}): Promise<void> {
  const { version, port, userDataDir, signal, deps } = opts;
  const wsUrl = wsUrlOf(version);
  let actualDir: string | undefined;
  if (wsUrl !== undefined) {
    try {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(PROOF_TIMEOUT_MS)]);
      actualDir = await deps.readUserDataDir(wsUrl, bounded);
    } catch {
      actualDir = undefined;
    }
  }
  if (
    actualDir !== undefined &&
    canonical(actualDir, deps) === canonical(userDataDir, deps)
  ) {
    return;
  }
  throw new ForeignChromeError(port, actualDir, userDataDir);
}
