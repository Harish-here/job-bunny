import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkedinPacingSettingsSchema } from './index.ts';

/**
 * linkedin_pacing.test.ts — ported from `cli/wire/settings.test.ts`'s
 * pacing cases (relocation, blueprint-be.md §3.1). Exercises the schema
 * directly rather than through `resolveJitterRange`/`resolveInterUrlDelayRange`
 * (those stay in `cli/wire/settings.ts` and keep their own unmodified test
 * coverage there).
 */

test('LinkedinPacingSettingsSchema: a valid range parses, including one-sided overrides and zero-length', () => {
  const full = LinkedinPacingSettingsSchema.parse({
    jitterMinMs: 500,
    jitterMaxMs: 1_500,
    interUrlDelayMinMs: 1_000,
    interUrlDelayMaxMs: 2_000,
  });
  assert.deepEqual(full, {
    jitterMinMs: 500,
    jitterMaxMs: 1_500,
    interUrlDelayMinMs: 1_000,
    interUrlDelayMaxMs: 2_000,
  });

  // Only jitterMinMs overridden — jitterMaxMs still defaults to 12000, and
  // 1000 <= 12000 so this is still a valid range.
  const oneSided = LinkedinPacingSettingsSchema.parse({ jitterMinMs: 1_000 });
  assert.equal(oneSided.jitterMinMs, 1_000);
  assert.equal(oneSided.jitterMaxMs, 12_000);

  // A zero-length range (both 0) is valid — the "no jitter" case.
  const zero = LinkedinPacingSettingsSchema.parse({
    jitterMinMs: 0,
    jitterMaxMs: 0,
    interUrlDelayMinMs: 0,
    interUrlDelayMaxMs: 0,
  });
  assert.equal(zero.jitterMinMs, 0);
  assert.equal(zero.jitterMaxMs, 0);
});

test('LinkedinPacingSettingsSchema: missing keys default quietly', () => {
  const defaulted = LinkedinPacingSettingsSchema.parse({});
  assert.deepEqual(defaulted, {
    jitterMinMs: 5_000,
    jitterMaxMs: 12_000,
    interUrlDelayMinMs: 20_000,
    interUrlDelayMaxMs: 45_000,
  });
});

test('LinkedinPacingSettingsSchema: jitterMinMs > jitterMaxMs throws with the existing message text', () => {
  assert.throws(
    () => LinkedinPacingSettingsSchema.parse({ jitterMinMs: 5_000, jitterMaxMs: 2_000 }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(
        'settings.linkedin.jitterMinMs must be <= settings.linkedin.jitterMaxMs',
      ),
  );
  // Same failure via the one-sided override: default jitterMinMs (5000)
  // now exceeds the configured jitterMaxMs.
  assert.throws(() => LinkedinPacingSettingsSchema.parse({ jitterMaxMs: 1_000 }));
});

test('LinkedinPacingSettingsSchema: interUrlDelayMinMs > interUrlDelayMaxMs throws with the existing message text', () => {
  assert.throws(
    () =>
      LinkedinPacingSettingsSchema.parse({
        interUrlDelayMinMs: 45_000,
        interUrlDelayMaxMs: 20_000,
      }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(
        'settings.linkedin.interUrlDelayMinMs must be <= settings.linkedin.interUrlDelayMaxMs',
      ),
  );
});

test('LinkedinPacingSettingsSchema: fails LOUD on a negative jitterMinMs or jitterMaxMs', () => {
  assert.throws(() =>
    LinkedinPacingSettingsSchema.parse({ jitterMinMs: -1, jitterMaxMs: 5_000 }),
  );
  assert.throws(() =>
    LinkedinPacingSettingsSchema.parse({ jitterMinMs: 2_000, jitterMaxMs: -1 }),
  );
});
