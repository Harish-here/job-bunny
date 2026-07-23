/**
 * Byte-exact parity test between this file's schema.ts pin and v0's
 * scripts/notion/schema.js (the single source of truth while both trees
 * coexist). Dynamically imports v0's module *at test-run time* — never a
 * hardcoded second copy of the option strings — so drift is structurally
 * impossible: if someone edits one file without the other, this test fails
 * the next time it runs, not "whenever someone remembers to check".
 *
 * Boundary note: `src/` importing from `scripts/` would normally be a
 * layering violation, but `.dependency-cruiser.cjs`'s `includeOnly: '^src'`
 * means modules outside `src/` are dropped before rule evaluation — verified
 * with `npx depcruise src` (zero violations, and the JSON reporter shows
 * this file as an "orphan" with no tracked dependency edge to
 * scripts/notion/schema.js at all). So the dynamic-import path is safe to
 * ship as-is; see the executor's NOTES for the exact command run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTOMATED_FIELDS,
  type NotionPropertyType,
  OPTIONS,
  PROPERTIES,
} from './schema.ts';

// v0's schema.js — read live at test time (not copy-pasted) so this test
// actually catches drift rather than restating a second hardcoded truth.
// tsconfig.json's `include` is `src` only, so this plain-JS module outside
// it has no declaration file for tsc to check against (TS7016) — expected
// and harmless here: the test itself is the type check, at runtime, every run.
// @ts-expect-error TS7016 — v0's schema.js is outside the `src` program; see comment above.
const v0 = await import('../../../../scripts/notion/schema.js');

test('OPTIONS.seniorityLevel matches v0 SENIORITY_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.seniorityLevel,
    v0.SENIORITY_OPTIONS,
    'seniorityLevel option group drifted from v0',
  );
});

test('OPTIONS.workType matches v0 WORK_TYPE_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.workType,
    v0.WORK_TYPE_OPTIONS,
    'workType option group drifted from v0',
  );
});

test('OPTIONS.timezone matches v0 TIMEZONE_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.timezone,
    v0.TIMEZONE_OPTIONS,
    'timezone option group drifted from v0',
  );
});

test('OPTIONS.excitement matches v0 EXCITEMENT_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.excitement,
    v0.EXCITEMENT_OPTIONS,
    'excitement option group drifted from v0',
  );
});

test('OPTIONS.status matches v0 STATUS_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.status,
    v0.STATUS_OPTIONS,
    'status option group drifted from v0',
  );
});

test('PROPERTIES has one entry per v0 DB_PROPERTIES key, same set of names', () => {
  const v0Names = Object.keys(v0.DB_PROPERTIES).sort();
  const v2Names = Object.values(PROPERTIES)
    .map((p) => p.name)
    .sort();
  assert.deepEqual(
    v2Names,
    v0Names,
    'PROPERTIES names drifted from v0 DB_PROPERTIES keys',
  );
});

test('every PROPERTIES entry has the byte-exact name and Notion type v0 assigns it', () => {
  for (const [logicalName, descriptor] of Object.entries(PROPERTIES)) {
    const v0Definition = v0.DB_PROPERTIES[descriptor.name];
    assert.ok(
      v0Definition,
      `PROPERTIES.${logicalName} names "${descriptor.name}", which is not a v0 DB_PROPERTIES key`,
    );
    const v0Type = Object.keys(v0Definition)[0] as NotionPropertyType;
    assert.equal(
      descriptor.type,
      v0Type,
      `PROPERTIES.${logicalName} ("${descriptor.name}") has type "${descriptor.type}" but v0 defines "${v0Type}"`,
    );
  }
});

test('every v0 select-type property has a matching OPTIONS group with byte-exact strings', () => {
  for (const [propName, definition] of Object.entries(v0.DB_PROPERTIES)) {
    const def = definition as { select?: { options: Array<{ name: string }> } };
    if (!def.select) continue;
    const logicalName = Object.entries(PROPERTIES).find(
      ([, d]) => d.name === propName,
    )?.[0];
    assert.ok(logicalName, `no PROPERTIES entry names v0 select property "${propName}"`);
    const group = OPTIONS[logicalName as keyof typeof OPTIONS];
    assert.ok(
      group,
      `OPTIONS has no group for select property "${propName}" (logical name "${logicalName}")`,
    );
    const v0OptionNames = def.select.options.map((o) => o.name);
    assert.deepEqual(
      [...group],
      v0OptionNames,
      `OPTIONS.${logicalName} drifted from v0 DB_PROPERTIES["${propName}"].select.options`,
    );
  }
});

test('AUTOMATED_FIELDS matches v0 AUTOMATED_FIELDS byte-exact (order included)', () => {
  assert.deepEqual(
    [...AUTOMATED_FIELDS],
    v0.AUTOMATED_FIELDS,
    'AUTOMATED_FIELDS drifted from v0',
  );
});
