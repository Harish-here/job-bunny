/**
 * Split out of provider.ts (headless-wiring packet, 2026-08-17) purely to
 * keep that file under the 400-line cap — no behavioral change, `connectWithRetry`
 * is `raceWithTimeout`'s only caller.
 *
 * Races an in-flight promise against a timer of `ms` — used to enforce
 * connectMaxWaitMs on a single connect() attempt (playwright's
 * connectOverCDP has its own internal ~30s timeout that must never be
 * allowed to outlive our configured cap). The timer is always cleared,
 * whichever side settles first, so a losing timer can never keep the
 * process alive or leak. `task` itself is left to settle on its own time —
 * Promise.race attaches a handler to it, so a late rejection never surfaces
 * as an unhandled rejection.
 */
export function raceWithTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(new Error(`connect attempt exceeded ${Math.max(ms, 0)}ms`));
      },
      Math.max(ms, 0),
    );
  });
  return Promise.race([task, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
