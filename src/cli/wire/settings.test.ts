import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveInterUrlDelayRange,
  resolveInventoryMaxAgeDays,
  resolveJitterRange,
  resolveLoggingSettings,
} from './settings.ts';

/**
 * settings.test.ts (P8, split from wire.test.ts) — exercises the PURE
 * settings resolvers (`resolveInventoryMaxAgeDays`, `resolveJitterRange`,
 * `resolveInterUrlDelayRange`). No real adapter is imported here —
 * depcruise's `only-wire-imports-adapters` rule forbids it for every file
 * under `src/cli` except `cli/wire/compose.ts` (and `registry.ts`'s
 * type-only exception — see its doc comment; see `.dependency-cruiser.cjs`).
 */

// --- resolveInventoryMaxAgeDays ---

test('resolveInventoryMaxAgeDays: defaults to 30 when settings has no maxAgeDays', () => {
  assert.equal(resolveInventoryMaxAgeDays(undefined), 30);
  assert.equal(resolveInventoryMaxAgeDays({}), 30);
  assert.equal(resolveInventoryMaxAgeDays(null), 30);
});

test('resolveInventoryMaxAgeDays: honors a configured positive number', () => {
  assert.equal(resolveInventoryMaxAgeDays({ maxAgeDays: 7 }), 7);
  assert.equal(resolveInventoryMaxAgeDays({ maxAgeDays: 90 }), 90);
});

test('resolveInventoryMaxAgeDays: falls back to 30 on an invalid configured value', () => {
  assert.equal(resolveInventoryMaxAgeDays({ maxAgeDays: 0 }), 30);
  assert.equal(resolveInventoryMaxAgeDays({ maxAgeDays: -5 }), 30);
  assert.equal(resolveInventoryMaxAgeDays({ maxAgeDays: Number.NaN }), 30);
  assert.equal(resolveInventoryMaxAgeDays({ maxAgeDays: 'thirty' }), 30);
});

// --- linkedin pacing settings (throttle guard D2/D3, 2026-07-28) ---

test('resolveJitterRange: defaults to the throttle-guard range (5000, 12000) when settings has no jitter keys', () => {
  assert.deepEqual(resolveJitterRange(undefined), { minMs: 5_000, maxMs: 12_000 });
  assert.deepEqual(resolveJitterRange({}), { minMs: 5_000, maxMs: 12_000 });
  assert.deepEqual(resolveJitterRange(null), { minMs: 5_000, maxMs: 12_000 });
});

test('resolveJitterRange: honors a configured valid range, including one-sided overrides', () => {
  assert.deepEqual(resolveJitterRange({ jitterMinMs: 500, jitterMaxMs: 1_500 }), {
    minMs: 500,
    maxMs: 1_500,
  });
  // Only jitterMinMs overridden — jitterMaxMs still defaults to 12000, and
  // 1000 <= 12000 so this is still a valid range.
  assert.deepEqual(resolveJitterRange({ jitterMinMs: 1_000 }), {
    minMs: 1_000,
    maxMs: 12_000,
  });
  // A zero-length range (both 0) is valid — the "no jitter" case.
  assert.deepEqual(resolveJitterRange({ jitterMinMs: 0, jitterMaxMs: 0 }), {
    minMs: 0,
    maxMs: 0,
  });
});

test('resolveJitterRange: fails LOUD (throws) when jitterMinMs > jitterMaxMs', () => {
  assert.throws(() => resolveJitterRange({ jitterMinMs: 5_000, jitterMaxMs: 2_000 }));
  // Same failure via the one-sided override: default jitterMinMs (5000)
  // now exceeds the configured jitterMaxMs.
  assert.throws(() => resolveJitterRange({ jitterMaxMs: 1_000 }));
});

test('resolveJitterRange: fails LOUD (throws) on a negative jitterMinMs or jitterMaxMs', () => {
  assert.throws(() => resolveJitterRange({ jitterMinMs: -1, jitterMaxMs: 5_000 }));
  assert.throws(() => resolveJitterRange({ jitterMinMs: 2_000, jitterMaxMs: -1 }));
});

test('resolveInterUrlDelayRange: defaults to (20000, 45000) when settings has no inter-url keys', () => {
  assert.deepEqual(resolveInterUrlDelayRange(undefined), {
    minMs: 20_000,
    maxMs: 45_000,
  });
  assert.deepEqual(resolveInterUrlDelayRange({}), { minMs: 20_000, maxMs: 45_000 });
  assert.deepEqual(resolveInterUrlDelayRange(null), { minMs: 20_000, maxMs: 45_000 });
});

test('resolveInterUrlDelayRange: honors a configured valid range and a zero-length one', () => {
  assert.deepEqual(
    resolveInterUrlDelayRange({ interUrlDelayMinMs: 1_000, interUrlDelayMaxMs: 2_000 }),
    { minMs: 1_000, maxMs: 2_000 },
  );
  assert.deepEqual(
    resolveInterUrlDelayRange({ interUrlDelayMinMs: 0, interUrlDelayMaxMs: 0 }),
    { minMs: 0, maxMs: 0 },
  );
});

test('resolveInterUrlDelayRange: fails LOUD on an inverted or negative range', () => {
  assert.throws(() =>
    resolveInterUrlDelayRange({ interUrlDelayMinMs: 45_000, interUrlDelayMaxMs: 20_000 }),
  );
  assert.throws(() => resolveInterUrlDelayRange({ interUrlDelayMinMs: -1 }));
});

test('both resolvers parse the SAME settings blob, so an invalid jitter range throws out of either entry point', () => {
  // Deliberate (D3): one schema validates both pairs, so a profile cannot
  // end up with a valid inter-url range quietly sitting next to an
  // inverted jitter one just because the caller only read the other pair.
  assert.throws(() =>
    resolveInterUrlDelayRange({ jitterMinMs: 9_000, jitterMaxMs: 1_000 }),
  );
});

// --- resolveLoggingSettings (settings.logging) ---

test('resolveLoggingSettings: missing settings default to {fileLevel: debug, ttyLevel: info}', () => {
  assert.deepEqual(resolveLoggingSettings(undefined), {
    fileLevel: 'debug',
    ttyLevel: 'info',
  });
  assert.deepEqual(resolveLoggingSettings({}), { fileLevel: 'debug', ttyLevel: 'info' });
});

test('resolveLoggingSettings: a present-but-invalid settings.logging throws (fail loud)', () => {
  assert.throws(() => resolveLoggingSettings({ ttyLevel: 'loud' }));
  assert.throws(() => resolveLoggingSettings({ fileLevel: 'quiet' }));
});

test('resolveLoggingSettings: a valid env override replaces ttyLevel only', () => {
  assert.deepEqual(resolveLoggingSettings(undefined, 'debug'), {
    fileLevel: 'debug',
    ttyLevel: 'debug',
  });
  assert.deepEqual(resolveLoggingSettings({ fileLevel: 'warn' }, 'error'), {
    fileLevel: 'warn',
    ttyLevel: 'error',
  });
});

test('resolveLoggingSettings: an invalid or empty env override is ignored quietly', () => {
  assert.deepEqual(resolveLoggingSettings(undefined, 'loud'), {
    fileLevel: 'debug',
    ttyLevel: 'info',
  });
  assert.deepEqual(resolveLoggingSettings(undefined, ''), {
    fileLevel: 'debug',
    ttyLevel: 'info',
  });
  assert.deepEqual(resolveLoggingSettings(undefined, undefined), {
    fileLevel: 'debug',
    ttyLevel: 'info',
  });
});
