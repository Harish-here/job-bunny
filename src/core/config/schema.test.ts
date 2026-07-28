import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PipelineConfigSchema } from './schema.ts';

test('minimal config gets defaults', () => {
  const cfg = PipelineConfigSchema.parse({ connector: 'notion' });
  assert.deepEqual(cfg.lanes, []);
  assert.deepEqual(cfg.notifiers, []);
  assert.deepEqual(cfg.routines, []);
  assert.deepEqual(cfg.settings, {});
  assert.equal(cfg.schedule, undefined);
});

test('full config parses; adapter settings pass through opaquely', () => {
  const cfg = PipelineConfigSchema.parse({
    lanes: ['linkedin', 'greenhouse', 'keka'],
    connector: 'notion',
    notifiers: ['telegram'],
    routines: ['cleanup'],
    schedule: { times: ['07:30', '18:00'] },
    settings: { notion: { dbId: 'abc' }, telegram: { chatId: 42 } },
  });
  assert.equal(cfg.lanes.length, 3);
  assert.deepEqual(cfg.settings.notion, { dbId: 'abc' });
});

test('rejects missing connector and malformed schedule times', () => {
  assert.throws(() => PipelineConfigSchema.parse({}));
  assert.throws(() =>
    PipelineConfigSchema.parse({ connector: 'notion', schedule: { times: ['7:30'] } }),
  );
  assert.throws(() =>
    PipelineConfigSchema.parse({ connector: 'notion', schedule: { times: ['25:00'] } }),
  );
});

test('schedule with only times gets enabled/weekdays/graceMinutes defaults', () => {
  const cfg = PipelineConfigSchema.parse({
    connector: 'notion',
    schedule: { times: ['09:00'] },
  });
  assert.deepEqual(cfg.schedule, {
    times: ['09:00'],
    enabled: true,
    weekdays: [1, 2, 3, 4, 5],
    graceMinutes: 90,
  });
});

test('schedule with explicit enabled/weekdays/graceMinutes preserves them', () => {
  const cfg = PipelineConfigSchema.parse({
    connector: 'notion',
    schedule: {
      times: ['09:00'],
      enabled: false,
      weekdays: [0, 6],
      graceMinutes: 45,
    },
  });
  assert.deepEqual(cfg.schedule, {
    times: ['09:00'],
    enabled: false,
    weekdays: [0, 6],
    graceMinutes: 45,
  });
});

test('rejects an out-of-range weekday', () => {
  assert.throws(() =>
    PipelineConfigSchema.parse({
      connector: 'notion',
      schedule: { times: ['09:00'], weekdays: [7] },
    }),
  );
});

test('rejects a non-positive graceMinutes', () => {
  assert.throws(() =>
    PipelineConfigSchema.parse({
      connector: 'notion',
      schedule: { times: ['09:00'], graceMinutes: 0 },
    }),
  );
});

test('a config with no schedule key at all still parses fine', () => {
  const cfg = PipelineConfigSchema.parse({ connector: 'notion' });
  assert.equal(cfg.schedule, undefined);
});
