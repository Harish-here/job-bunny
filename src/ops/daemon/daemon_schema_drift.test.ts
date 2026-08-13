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
    },
  });
  await createDaemon(deps).tick();
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0]!.text, /harish/);
  assert.match(notifyCalls[0]!.text, /rajni/);
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
    },
  });
  await createDaemon(deps).tick();
  assert.deepEqual(notifyCalls, ['beta']);
});

test('schema drift: no scheduled profile has a notifier configured — zero sends, schemaDriftNotifiedAt stays null, and the skip is logged every qualifying tick', async () => {
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
  assert.equal(readDaemonPidfile(deps.root, deps.pidfile)?.schemaDriftNotifiedAt, null);
  const skips = events.filter(
    (e) => e.event === 'schema-drift-notify-skipped-no-notifier',
  );
  assert.equal(skips.length, 2);
  assert.equal(skips[0]?.level, 'warn');
});
