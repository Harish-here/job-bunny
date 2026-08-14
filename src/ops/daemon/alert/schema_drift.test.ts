import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeSchemaDriftAlertText } from './schema_drift.ts';

test('composeSchemaDriftAlertText: a single degraded profile uses the mockup literal single-profile copy', () => {
  const text = composeSchemaDriftAlertText([
    {
      profile: 'harish',
      schemaVersion: 7,
      buildVersion: 6,
      detectedAt: '2026-08-13T10:00:00.000Z',
    },
  ]);
  assert.match(text, /Cause: the database schema \(v7\) is newer than the/);
  assert.match(text, /running daemon's build \(v6\)\./);
  assert.match(text, /Affected profiles: harish/);
  assert.match(text, /jobbunny serve stop/);
  assert.match(text, /jobbunny serve start/);
});

test('composeSchemaDriftAlertText: multiple degraded profiles list each profile with its own schema version', () => {
  const text = composeSchemaDriftAlertText([
    {
      profile: 'harish',
      schemaVersion: 8,
      buildVersion: 7,
      detectedAt: '2026-08-13T10:00:00.000Z',
    },
    {
      profile: 'rajni',
      schemaVersion: 9,
      buildVersion: 7,
      detectedAt: '2026-08-13T10:05:00.000Z',
    },
  ]);
  assert.match(text, /Affected profiles: harish \(v8\), rajni \(v9\)/);
  assert.match(text, /running daemon's build \(v7\)/);
});
