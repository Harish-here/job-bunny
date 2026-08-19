/**
 * ops/daemon/daemon_schema_drift.test.ts — Task 6's schema-drift/notify
 * dispatch suite, split from `daemon.test.ts` into its own colocated file
 * for the same file-size-cap reason `./testkit/` fixtures were split out
 * (see `testkit/fixtures.ts`'s doc comment): `daemon.test.ts` was already
 * at the 800-line test-file cap before this task, with zero headroom for
 * these four cases. Precedent for an extra same-folder `*.test.ts` file
 * covering the same module: `pipeline/stages/tail_e2e.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS } from './alert/index.ts';
import { createDaemon } from './daemon.ts';
import { readDaemonPidfile } from './pidfile.ts';
import {
  baseDeps,
  fakeScanDeps,
  PROFILES_DIR,
  profileJson,
  profilePath,
} from './testkit/index.ts';

test('schema drift: two profiles degrading in the same tick produce exactly one notify call naming both', async () => {
  const notifyCalls: { profile: string; text: string }[] = [];
  const scan = fakeScanDeps(
    {
      [profilePath('harish')]: profileJson({ times: ['14:00'] }),
      [profilePath('rajni')]: profileJson({ times: ['14:00'] }),
    },
    { [PROFILES_DIR]: ['harish', 'rajni'] },
  );
  const { deps } = baseDeps({
    scan,
    checkSchemaDrift: () =>
      new Map([
        ['harish', { schemaVersion: 8, buildVersion: 7 }],
        ['rajni', { schemaVersion: 8, buildVersion: 7 }],
      ]),
    hasNotifierConfigured: async () => true,
    notify: async (profile, event) => {
      notifyCalls.push({ profile, text: event.text });
      return true;
    },
  });
  await createDaemon(deps).tick();
  assert.equal(notifyCalls.length, 1);
  const [call] = notifyCalls;
  assert.ok(call);
  assert.match(call.text, /harish/);
  assert.match(call.text, /rajni/);
});

test('schema drift: a third profile degrading on a later tick does not trigger a second notify call', async () => {
  const notifyCalls: string[] = [];
  let drift = new Map([
    ['harish', { schemaVersion: 8, buildVersion: 7 }],
    ['rajni', { schemaVersion: 8, buildVersion: 7 }],
  ]);
  const scan = fakeScanDeps(
    {
      [profilePath('harish')]: profileJson({ times: ['14:00'] }),
      [profilePath('rajni')]: profileJson({ times: ['14:00'] }),
      [profilePath('third')]: profileJson({ times: ['14:00'] }),
    },
    { [PROFILES_DIR]: ['harish', 'rajni', 'third'] },
  );
  const { deps } = baseDeps({
    scan,
    checkSchemaDrift: () => drift,
    hasNotifierConfigured: async () => true,
    notify: async (profile) => {
      notifyCalls.push(profile);
      return true;
    },
  });
  const daemon = createDaemon(deps);
  await daemon.tick();
  assert.equal(notifyCalls.length, 1);
  drift = new Map([...drift, ['third', { schemaVersion: 8, buildVersion: 7 }]]);
  await daemon.tick();
  await daemon.tick();
  await daemon.tick();
  assert.equal(notifyCalls.length, 1);
});

test('schema drift: the alphabetically-first scheduled profile without a notifier is skipped in favor of a later one that has one', async () => {
  const notifyCalls: string[] = [];
  const scan = fakeScanDeps(
    {
      [profilePath('alpha')]: profileJson({ times: ['14:00'] }),
      [profilePath('beta')]: profileJson({ times: ['14:00'] }),
    },
    { [PROFILES_DIR]: ['alpha', 'beta'] },
  );
  const { deps } = baseDeps({
    scan,
    checkSchemaDrift: () => new Map([['alpha', { schemaVersion: 8, buildVersion: 7 }]]),
    hasNotifierConfigured: async (profile) => profile === 'beta',
    notify: async (profile) => {
      notifyCalls.push(profile);
      return true;
    },
  });
  await createDaemon(deps).tick();
  assert.deepEqual(notifyCalls, ['beta']);
});

test('schema drift: a notify that resolves false (delivery never happened) never stamps schemaDriftNotifiedAt, retries are interval-throttled (not every tick), and a later success clears the throttle for immediate retry on the next failure', async () => {
  const notifyCalls: string[] = [];
  let notifyResult = false;
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = Date.parse('2026-08-13T10:00:00.000Z');
  const { deps, events } = baseDeps({
    scan,
    checkSchemaDrift: () => new Map([['harish', { schemaVersion: 8, buildVersion: 7 }]]),
    hasNotifierConfigured: async () => true,
    notify: async (profile) => {
      notifyCalls.push(profile);
      return notifyResult;
    },
    now: () => new Date(nowMs),
  });
  const daemon = createDaemon(deps);

  // (a) N ticks (5, well over the "one per tick" naive count) inside the
  // 1-hour retry interval produce exactly ONE send attempt and ONE log
  // line — every tick after the first is throttled entirely (no attempt,
  // no log), not just de-duplicated in the log.
  for (let i = 0; i < 5; i++) {
    await daemon.tick();
    nowMs += 5 * 60_000; // 5 minutes apart — 25 minutes total, still < 1h.
  }
  assert.equal(notifyCalls.length, 1);
  assert.equal(readDaemonPidfile(deps.root, deps.pidfile)?.schemaDriftNotifiedAt, null);
  assert.notEqual(
    readDaemonPidfile(deps.root, deps.pidfile)?.schemaDriftNotifyFailedAt,
    null,
  );
  let failures = events.filter((e) => e.event === 'schema-drift-notify-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.level, 'warn');

  // (b) Advancing PAST the retry interval produces a SECOND attempt.
  nowMs += SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS + 1;
  await daemon.tick();
  assert.equal(notifyCalls.length, 2);
  failures = events.filter((e) => e.event === 'schema-drift-notify-failed');
  assert.equal(failures.length, 2);

  // (c) A SUCCESSFUL send clears schemaDriftNotifyFailedAt, so a later
  // failure attempts immediately instead of waiting out a stale interval.
  notifyResult = true;
  nowMs += SCHEMA_DRIFT_NOTIFY_RETRY_INTERVAL_MS + 1;
  await daemon.tick();
  assert.equal(notifyCalls.length, 3);
  assert.notEqual(
    readDaemonPidfile(deps.root, deps.pidfile)?.schemaDriftNotifiedAt,
    null,
  );
  assert.equal(
    readDaemonPidfile(deps.root, deps.pidfile)?.schemaDriftNotifyFailedAt,
    null,
  );
});

test('schema drift: a notify that resolves true stamps schemaDriftNotifiedAt and logs schema-drift-notify-sent', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps, events } = baseDeps({
    scan,
    checkSchemaDrift: () => new Map([['harish', { schemaVersion: 8, buildVersion: 7 }]]),
    hasNotifierConfigured: async () => true,
    notify: async () => true,
  });
  await createDaemon(deps).tick();
  assert.notEqual(
    readDaemonPidfile(deps.root, deps.pidfile)?.schemaDriftNotifiedAt,
    null,
  );
  const sent = events.filter((e) => e.event === 'schema-drift-notify-sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.level, 'info');
});

test('schema drift: no scheduled profile has a notifier configured — zero sends, schemaDriftNotifiedAt stays null, and the skip is logged ONCE across the whole degraded episode (not every tick — AC14/R15)', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps, events } = baseDeps({
    scan,
    checkSchemaDrift: () => new Map([['harish', { schemaVersion: 8, buildVersion: 7 }]]),
    hasNotifierConfigured: async () => false,
    notify: async () => {
      throw new Error('must not be called');
    },
  });
  const daemon = createDaemon(deps);
  await daemon.tick();
  await daemon.tick();
  await daemon.tick();
  assert.equal(readDaemonPidfile(deps.root, deps.pidfile)?.schemaDriftNotifiedAt, null);
  const skips = events.filter(
    (e) => e.event === 'schema-drift-notify-skipped-no-notifier',
  );
  // 3 ticks in one continuous no-notifier episode — exactly one log line,
  // not one per tick (a 2,880-lines-a-day repeat is the exact outage D2
  // exists to fix — see qa-report.md Bug 5).
  assert.equal(skips.length, 1);
  assert.equal(skips[0]?.level, 'warn');
});

test('schema drift: the no-notifier skip logs again after the episode clears and a new one begins (latch resets, not a one-shot)', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let hasNotifier = false;
  const { deps, events } = baseDeps({
    scan,
    checkSchemaDrift: () => new Map([['harish', { schemaVersion: 8, buildVersion: 7 }]]),
    hasNotifierConfigured: async () => hasNotifier,
    // Always fails to deliver, so `schemaDriftNotifiedAt` never stamps —
    // the daemon-level alert stays eligible for retry, which is what lets
    // this scenario re-enter the no-notifier branch on a later tick
    // instead of exiting via the one-shot AC14 alert path.
    notify: async () => false,
  });
  const daemon = createDaemon(deps);

  // Episode 1: no notifier configured for two ticks — logs once.
  await daemon.tick();
  await daemon.tick();
  const skipsAfterEpisode1 = events.filter(
    (e) => e.event === 'schema-drift-notify-skipped-no-notifier',
  );
  assert.equal(skipsAfterEpisode1.length, 1);

  // The episode clears: a notifier becomes available this tick (a sender
  // is found), so no skip is logged and the latch resets.
  hasNotifier = true;
  await daemon.tick();
  const skipsAfterClear = events.filter(
    (e) => e.event === 'schema-drift-notify-skipped-no-notifier',
  );
  assert.equal(skipsAfterClear.length, 1); // still 1 — the cleared tick logged nothing new.

  // Episode 2 begins: no notifier again — a genuinely new episode, so it
  // logs again.
  hasNotifier = false;
  await daemon.tick();
  await daemon.tick();
  const skipsAfterEpisode2 = events.filter(
    (e) => e.event === 'schema-drift-notify-skipped-no-notifier',
  );
  assert.equal(skipsAfterEpisode2.length, 2);
});
