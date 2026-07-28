import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LinkedIn throttle circuit-breaker state (spec §4.4, D11) —
 * `<userDataDir>/.jobbunny-linkedin-breaker.json`.
 *
 * SESSION-scoped, not profile-scoped, and that is the whole point: the
 * throttle is a property of the shared `.chrome-debug` Chrome profile whose
 * cookies every profile farms through, so profile-scoped state would make
 * each profile relearn the same session-wide block. It sits next to the
 * Chrome pid file (`.jobbunny-chrome.json`) for exactly that reason, and
 * mirrors `adapters/browser/cdp-chrome/ownership/pidfile.ts`'s injectable-
 * deps shape (minus `pidIsAlive` — this state describes a time window, not
 * a process) so no test ever touches a real filesystem or clock.
 *
 * FAILURE POSTURE (D12): breaker state must never break a run. Every read
 * failure degrades to `undefined` (⇒ phase `closed` ⇒ farm normally) and
 * every write failure is swallowed into a `false` return. The worst case of
 * a lost write is that the next fire re-detects the throttle — exactly the
 * position the pipeline was in before this file existed.
 *
 * This module deliberately does NOT import `throttle.ts`: the cooldown is a
 * parameter of `breakerPhase`, so the store stays a plain file+phase
 * utility with no opinion about thresholds.
 */
export interface LinkedinBreakerState {
  /** ISO 8601 — when the breaker was last opened. */
  openedAt: string;
  /** Cumulative trips, diagnostic only. */
  tripCount: number;
  /** ISO 8601 — when a half-open probe last ran. */
  lastProbeAt?: string;
}

export interface LinkedinBreakerDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  /** Recursive mkdir of the breaker file's parent (userDataDir) — on a
   * fresh clone `.chrome-debug/` may not exist yet (spec §5). */
  mkdirSync(path: string): void;
  unlinkSync(path: string): void;
  now(): Date;
}

/** Everything the lane needs to reach the session-scoped breaker file.
 *
 * `userDataDir` is a plain string, NOT an import of
 * `adapters/browser/cdp-chrome`'s `DEFAULT_USER_DATA_DIR`: those are two
 * different adapter families and `.dependency-cruiser.cjs`'s
 * `adapters-no-cross-family` rule forbids the cross-import. `cli/wire/
 * builders.ts` — one of the files allowed to import any adapter — reads
 * the constant and passes it in here.
 *
 * The whole config is OPTIONAL on the constructor: omitted, the lane has
 * no breaker at all (no read, no write, no jdRoot presence probe), which
 * is what every pre-existing direct `new LinkedInLane(...)` call site
 * relies on. Production supplies it in `cli/wire/builders.ts`.
 *
 * Defined here (not in `lane.ts`) so `fire/url_runner.ts` can reach the
 * type without a circular import back through `lane.ts` -> `fire/index.ts`
 * -> `fire/url_runner.ts` -> `lane.ts`; `lane.ts` and `index.ts` both
 * import it from here instead. */
export interface LinkedinBreakerConfig {
  userDataDir: string;
  deps: LinkedinBreakerDeps;
}

/** Derived, never stored as a string (spec §4.4). */
export type BreakerPhase = 'closed' | 'open' | 'half-open';

const BREAKER_FILE_NAME = '.jobbunny-linkedin-breaker.json';

export function linkedinBreakerPath(userDataDir: string): string {
  return join(userDataDir, BREAKER_FILE_NAME);
}

function isBreakerShape(value: unknown): value is LinkedinBreakerState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LinkedinBreakerState>;
  if (typeof v.openedAt !== 'string' || !Number.isFinite(Date.parse(v.openedAt))) {
    return false;
  }
  if (typeof v.tripCount !== 'number' || !Number.isFinite(v.tripCount)) return false;
  return v.lastProbeAt === undefined || typeof v.lastProbeAt === 'string';
}

/**
 * Reads the breaker file. A missing, unreadable, unparseable, or
 * wrong-shaped file is `undefined` — which `breakerPhase` turns into
 * `closed`, i.e. farm normally (D12).
 *
 * `onCorrupt` fires ONLY when a file that EXISTS could not be turned into
 * usable state (unreadable, unparseable, or wrong-shaped), never for the
 * ordinary no-file case (spec §5 row 1: "treated as closed; warn logged").
 * Without it, "no breaker" and "the guard is silently disabled because its
 * state file is garbage" are indistinguishable to the caller — the lane
 * would keep farming into a block with nothing in the log to say why the
 * guard never fired. It is a callback rather than a returned discriminator
 * so the store keeps its "always degrade to undefined" signature and the
 * lane keeps ownership of how it reports (ctx.logger).
 *
 * Unlike the Chrome pid file this never self-heals by deleting a bad file:
 * deleting is a write, writes can fail, and a corrupt breaker file is
 * already harmless (it reads as closed). Leaving it in place also leaves
 * the evidence for whoever investigates.
 */
export function readBreaker(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
  onCorrupt?: (detail: string) => void,
): LinkedinBreakerState | undefined {
  const path = linkedinBreakerPath(userDataDir);
  try {
    // Deliberately outside the reporting try below: an existsSync that
    // throws cannot tell us whether a file is even there, so it is not
    // evidence of corruption and must stay silent.
    if (!deps.existsSync(path)) return undefined;
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(deps.readFileSync(path));
    if (isBreakerShape(parsed)) return parsed;
    onCorrupt?.(`${path} does not hold a valid breaker state object`);
  } catch (err) {
    onCorrupt?.(
      `${path} could not be read or parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return undefined;
}

/** Phase for `state` at `now` (spec §4.4). A missing state, or one whose
 * `openedAt` will not parse, is `closed` — corrupt state must never
 * masquerade as a permanent block. */
export function breakerPhase(
  state: LinkedinBreakerState | undefined,
  now: Date,
  cooldownMs: number,
): BreakerPhase {
  if (!state) return 'closed';
  const openedAtMs = Date.parse(state.openedAt);
  if (!Number.isFinite(openedAtMs)) return 'closed';
  return now.getTime() < openedAtMs + cooldownMs ? 'open' : 'half-open';
}

function writeState(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
  state: LinkedinBreakerState,
): boolean {
  try {
    deps.mkdirSync(userDataDir);
    deps.writeFileSync(linkedinBreakerPath(userDataDir), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Opens (or re-opens) the breaker: `openedAt = now`, `tripCount`
 * incremented off `prev`. Returns false on a failed write — the caller logs
 * a warning and continues (D12). */
export function openBreaker(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
  prev?: LinkedinBreakerState,
): boolean {
  const next: LinkedinBreakerState = {
    openedAt: deps.now().toISOString(),
    tripCount: (prev?.tripCount ?? 0) + 1,
  };
  // Preserved rather than dropped: a re-open following a failed half-open
  // probe should not erase the record of that probe.
  if (prev?.lastProbeAt !== undefined) next.lastProbeAt = prev.lastProbeAt;
  return writeState(userDataDir, deps, next);
}

/** Stamps `lastProbeAt = now` on an EXISTING open state, leaving
 * `openedAt`/`tripCount` untouched. With no prior state there is nothing to
 * stamp and this writes nothing: inventing an `openedAt` here would open a
 * breaker that a probe was only meant to observe. */
export function recordProbe(
  userDataDir: string,
  deps: LinkedinBreakerDeps,
  prev?: LinkedinBreakerState,
): boolean {
  if (!prev) return false;
  return writeState(userDataDir, deps, {
    openedAt: prev.openedAt,
    tripCount: prev.tripCount,
    lastProbeAt: deps.now().toISOString(),
  });
}

/** Closes the breaker by deleting the file — the absence of the file IS
 * the closed state. Every failure (ENOENT included) is swallowed. */
export function closeBreaker(userDataDir: string, deps: LinkedinBreakerDeps): void {
  try {
    const path = linkedinBreakerPath(userDataDir);
    if (!deps.existsSync(path)) return;
    deps.unlinkSync(path);
  } catch {
    // Nothing to do: a breaker file we failed to delete simply gets
    // re-probed on the next fire past its cooldown.
  }
}

/** Real (non-test) deps — node:fs sync calls plus a real clock, mirroring
 * `defaultChromePidfileDeps()` in
 * `adapters/browser/cdp-chrome/ownership/pidfile.ts`. */
export function defaultLinkedinBreakerDeps(): LinkedinBreakerDeps {
  return {
    existsSync: (path) => existsSync(path),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    writeFileSync: (path, data) => writeFileSync(path, data, 'utf8'),
    mkdirSync: (path) => {
      mkdirSync(path, { recursive: true });
    },
    unlinkSync: (path) => unlinkSync(path),
    now: () => new Date(),
  };
}
