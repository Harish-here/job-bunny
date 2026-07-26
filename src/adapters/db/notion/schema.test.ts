/**
 * Byte-exact pin test for this file's schema.ts against a FROZEN SNAPSHOT of
 * v0's `scripts/notion/schema.js` (the single source of truth while v0 was
 * still live). Originally this test dynamically imported v0's module at
 * test-run time; once v0's `scripts/` tree is deleted (post-cutover) that
 * import is a hard `ERR_MODULE_NOT_FOUND`, so the comparison values below
 * are copied byte-exact from `scripts/notion/schema.js` as it stood on
 * 2026-07-25 (the commit before v0's removal) and inlined here instead.
 *
 * These literals are NOT arbitrary test data — they are the exact
 * select-option strings the LIVE Notion database accepts. Notion select
 * options are matched by exact string against the live DB; changing one of
 * these without first updating the live database's select options makes
 * `sync` throw at runtime. If a select option genuinely needs to change:
 * update the live Notion DB's options first, then update `schema.ts`'s
 * exports, then update the frozen literals below to match — in that order.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTOMATED_FIELDS,
  type NotionPropertyType,
  OPTIONS,
  PROPERTIES,
} from './schema.ts';

// ---- Frozen snapshot of scripts/notion/schema.js (byte-exact, 2026-07-25) ----

const V0_SENIORITY_OPTIONS = ['Staff', 'Lead', 'Mid', 'Manager', 'Senior'];
const V0_WORK_TYPE_OPTIONS = ['Remote', 'Hybrid', 'On-site'];
const V0_TIMEZONE_OPTIONS = ['APAC', 'EMEA'];
const V0_EXCITEMENT_OPTIONS = ['Vera level', 'Kandipa podu', 'Try panalam'];
const V0_STATUS_OPTIONS = [
  'Lead',
  'Applied',
  'Recruiter Screen',
  'Tech Round',
  'Onsite',
  'Offer',
  'Rejected',
  'Passed',
];

// v0's DB_PROPERTIES, inlined as { name: { type: {} } } — mirrors the shape
// `select()`/plain type builders produced in scripts/notion/schema.js.
const V0_DB_PROPERTIES: Record<string, Record<string, unknown>> = {
  'Job Title': { title: {} },
  Company: { rich_text: {} },
  'Seniority Level': {
    select: { options: V0_SENIORITY_OPTIONS.map((name) => ({ name })) },
  },
  'Location City': { rich_text: {} },
  'Work Type': { select: { options: V0_WORK_TYPE_OPTIONS.map((name) => ({ name })) } },
  YoE: { number: {} },
  'YoE Is Minimum': { checkbox: {} },
  'Key Skills': { rich_text: {} },
  'Job URL': { url: {} },
  'Date Found': { date: {} },
  Timezone: { select: { options: V0_TIMEZONE_OPTIONS.map((name) => ({ name })) } },
  'Source URL': { url: {} },
  Excitement: { select: { options: V0_EXCITEMENT_OPTIONS.map((name) => ({ name })) } },
  'Match Reasons': { rich_text: {} },
  'Review Flags': { rich_text: {} },
  Status: { select: { options: V0_STATUS_OPTIONS.map((name) => ({ name })) } },
  'Comp Range': { rich_text: {} },
  Notes: { rich_text: {} },
  Contact: { rich_text: {} },
  'Date Applied': { date: {} },
  'Next Action': { rich_text: {} },
  'Next Action Date': { date: {} },
};

const V0_AUTOMATED_FIELDS = [
  'Job Title',
  'Company',
  'Seniority Level',
  'Location City',
  'Work Type',
  'YoE',
  'YoE Is Minimum',
  'Key Skills',
  'Job URL',
  'Date Found',
  'Timezone',
  'Source URL',
  'Excitement',
  'Match Reasons',
  'Review Flags',
];

test('OPTIONS.seniorityLevel matches the frozen v0 SENIORITY_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.seniorityLevel,
    V0_SENIORITY_OPTIONS,
    'seniorityLevel option group drifted from the frozen v0 snapshot',
  );
});

test('OPTIONS.workType matches the frozen v0 WORK_TYPE_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.workType,
    V0_WORK_TYPE_OPTIONS,
    'workType option group drifted from the frozen v0 snapshot',
  );
});

test('OPTIONS.timezone matches the frozen v0 TIMEZONE_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.timezone,
    V0_TIMEZONE_OPTIONS,
    'timezone option group drifted from the frozen v0 snapshot',
  );
});

test('OPTIONS.excitement matches the frozen v0 EXCITEMENT_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.excitement,
    V0_EXCITEMENT_OPTIONS,
    'excitement option group drifted from the frozen v0 snapshot',
  );
});

test('OPTIONS.status matches the frozen v0 STATUS_OPTIONS byte-exact', () => {
  assert.deepEqual(
    OPTIONS.status,
    V0_STATUS_OPTIONS,
    'status option group drifted from the frozen v0 snapshot',
  );
});

test('PROPERTIES has one entry per frozen v0 DB_PROPERTIES key, same set of names', () => {
  const v0Names = Object.keys(V0_DB_PROPERTIES).sort();
  const v2Names = Object.values(PROPERTIES)
    .map((p) => p.name)
    .sort();
  assert.deepEqual(
    v2Names,
    v0Names,
    'PROPERTIES names drifted from the frozen v0 DB_PROPERTIES keys',
  );
});

test('every PROPERTIES entry has the byte-exact name and Notion type the frozen v0 snapshot assigns it', () => {
  for (const [logicalName, descriptor] of Object.entries(PROPERTIES)) {
    const v0Definition = V0_DB_PROPERTIES[descriptor.name];
    assert.ok(
      v0Definition,
      `PROPERTIES.${logicalName} names "${descriptor.name}", which is not a frozen v0 DB_PROPERTIES key`,
    );
    const v0Type = Object.keys(v0Definition)[0] as NotionPropertyType;
    assert.equal(
      descriptor.type,
      v0Type,
      `PROPERTIES.${logicalName} ("${descriptor.name}") has type "${descriptor.type}" but the frozen v0 snapshot defines "${v0Type}"`,
    );
  }
});

test('every frozen v0 select-type property has a matching OPTIONS group with byte-exact strings', () => {
  for (const [propName, definition] of Object.entries(V0_DB_PROPERTIES)) {
    const def = definition as { select?: { options: Array<{ name: string }> } };
    if (!def.select) continue;
    const logicalName = Object.entries(PROPERTIES).find(
      ([, d]) => d.name === propName,
    )?.[0];
    assert.ok(
      logicalName,
      `no PROPERTIES entry names frozen v0 select property "${propName}"`,
    );
    const group = OPTIONS[logicalName as keyof typeof OPTIONS];
    assert.ok(
      group,
      `OPTIONS has no group for select property "${propName}" (logical name "${logicalName}")`,
    );
    const v0OptionNames = def.select.options.map((o) => o.name);
    assert.deepEqual(
      [...group],
      v0OptionNames,
      `OPTIONS.${logicalName} drifted from the frozen v0 DB_PROPERTIES["${propName}"].select.options`,
    );
  }
});

test('AUTOMATED_FIELDS matches the frozen v0 AUTOMATED_FIELDS byte-exact (order included)', () => {
  assert.deepEqual(
    [...AUTOMATED_FIELDS],
    V0_AUTOMATED_FIELDS,
    'AUTOMATED_FIELDS drifted from the frozen v0 snapshot',
  );
});
