import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireDaemonPidfile, readDaemonPidfile } from '../../pidfile.ts';
import { fakePidfileDeps, ROOT } from '../../testkit/index.ts';
import {
  DEFERRED_NOTIFY_ATTEMPT_MAX_AGE_MS,
  DEFERRED_NOTIFY_RETRY_INTERVAL_MS,
  isNotifyThrottled,
  stampNotifyAttempt,
} from './notify_throttle.ts';

const NOW = new Date(2026, 6, 27, 20, 0);

test('isNotifyThrottled: no entry for the (profile, date) pair -> not throttled', () => {
  assert.equal(isNotifyThrottled(undefined, 'harish', '2026-07-27', NOW), false);
});

test('isNotifyThrottled: an entry within the retry interval -> throttled', () => {
  const pidfileNow = {
    deferredNotifyAttempts: [
      {
        profile: 'harish',
        date: '2026-07-27',
        at: new Date(NOW.getTime() - 1000).toISOString(),
      },
    ],
  } as Parameters<typeof isNotifyThrottled>[0];
  assert.equal(isNotifyThrottled(pidfileNow, 'harish', '2026-07-27', NOW), true);
});

test('isNotifyThrottled: an entry past the retry interval -> not throttled', () => {
  const pidfileNow = {
    deferredNotifyAttempts: [
      {
        profile: 'harish',
        date: '2026-07-27',
        at: new Date(NOW.getTime() - DEFERRED_NOTIFY_RETRY_INTERVAL_MS - 1).toISOString(),
      },
    ],
  } as Parameters<typeof isNotifyThrottled>[0];
  assert.equal(isNotifyThrottled(pidfileNow, 'harish', '2026-07-27', NOW), false);
});

test('isNotifyThrottled: a malformed `at` fails open to not-throttled', () => {
  const pidfileNow = {
    deferredNotifyAttempts: [{ profile: 'harish', date: '2026-07-27', at: 'not-a-date' }],
  } as Parameters<typeof isNotifyThrottled>[0];
  assert.equal(isNotifyThrottled(pidfileNow, 'harish', '2026-07-27', NOW), false);
});

test('stampNotifyAttempt: upserts one entry per (profile, date) pair — a second stamp for the SAME pair replaces, not duplicates', () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1, pidfile);
  stampNotifyAttempt(ROOT, pidfile, 'harish', '2026-07-27', NOW);
  stampNotifyAttempt(
    ROOT,
    pidfile,
    'harish',
    '2026-07-27',
    new Date(NOW.getTime() + 60_000),
  );
  const attempts = readDaemonPidfile(ROOT, pidfile)?.deferredNotifyAttempts ?? [];
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.at, new Date(NOW.getTime() + 60_000).toISOString());
});

test('bug 9: a DIFFERENT (profile, date) entry still inside the 24h prune window is RETAINED across a later stamp for another pair, so its own 1h throttle keeps working', () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1, pidfile);
  stampNotifyAttempt(ROOT, pidfile, 'harish', '2026-07-20', NOW);
  stampNotifyAttempt(ROOT, pidfile, 'harish', '2026-07-26', NOW);
  assert.equal(readDaemonPidfile(ROOT, pidfile)?.deferredNotifyAttempts.length, 2);

  // A later stamp for the 07-26 pair, only 30s later — well within both
  // the 1h retry interval and the 24h prune window. The 07-20 entry must
  // survive: it is still comfortably inside the prune window, so its own
  // throttle keeps suppressing a repeat attempt for THAT date.
  const later = new Date(NOW.getTime() + 30_000);
  stampNotifyAttempt(ROOT, pidfile, 'harish', '2026-07-26', later);
  const attempts = readDaemonPidfile(ROOT, pidfile)?.deferredNotifyAttempts ?? [];
  assert.equal(
    attempts.length,
    2,
    'the older, still-fresh 07-20 entry must not be pruned',
  );
  assert.ok(
    isNotifyThrottled(
      { deferredNotifyAttempts: attempts } as Parameters<typeof isNotifyThrottled>[0],
      'harish',
      '2026-07-20',
      later,
    ),
    '07-20 must still be throttled — its entry was retained',
  );
});

test('bug 9: an entry older than DEFERRED_NOTIFY_ATTEMPT_MAX_AGE_MS is pruned by a later stamp for a DIFFERENT pair', () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1, pidfile);
  stampNotifyAttempt(ROOT, pidfile, 'harish', '2026-07-01', NOW);

  const wellPastPruneWindow = new Date(
    NOW.getTime() + DEFERRED_NOTIFY_ATTEMPT_MAX_AGE_MS + 1,
  );
  stampNotifyAttempt(ROOT, pidfile, 'harish', '2026-07-02', wellPastPruneWindow);

  const attempts = readDaemonPidfile(ROOT, pidfile)?.deferredNotifyAttempts ?? [];
  assert.equal(
    attempts.length,
    1,
    'the stale 07-01 entry must be pruned, leaving only 07-02',
  );
  assert.equal(attempts[0]?.date, '2026-07-02');
});

test('bug 9: deferredNotifyAttempts stays bounded across 30 simulated days of daily deferrals, instead of accumulating one entry per day forever', () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1, pidfile);

  let now = NOW;
  for (let day = 0; day < 30; day++) {
    const date = `2026-08-${String(day + 1).padStart(2, '0')}`;
    stampNotifyAttempt(ROOT, pidfile, 'harish', date, now);
    // Advance well past the 24h prune window (25h) between days, matching
    // a realistic daily-tick cadence — each new day's own stamp prunes
    // the PRIOR day's now-stale entry.
    now = new Date(now.getTime() + 25 * 60 * 60_000);
  }

  const attempts = readDaemonPidfile(ROOT, pidfile)?.deferredNotifyAttempts ?? [];
  assert.equal(
    attempts.length,
    1,
    `expected the array to stay flat at 1 entry across 30 days, got ${attempts.length} — the old exact-pair-only de-dup would have grown to 30`,
  );
});
