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
  assert.deepEqual(cfg.settings['notion'], { dbId: 'abc' });
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
