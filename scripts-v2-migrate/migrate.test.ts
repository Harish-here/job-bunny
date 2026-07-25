import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRegistry,
  migrate,
  parseAvoidMd,
  parseBoardsMd,
  type V0Inputs,
} from './migrate.ts';

const NOW = '2026-07-25T10:00:00.000Z';

function v0(overrides: Partial<V0Inputs> = {}): V0Inputs {
  return {
    profile: {
      notion_db_id: 'db-123',
      notion_parent_page_id: 'page-456',
      schedule: { enabled: true, times: ['09:00', '14:00'] },
      notify: { telegram: { enabled: true, chat_id: '98765' } },
    },
    filterConfig: {
      title_filter: {
        seniority: ['staff', 'lead'],
        domain: ['frontend', 'react'],
        function: { allow: ['engineer'], block: ['manager', 'qa'] },
      },
      locations: [{ city: 'Chennai', country: 'India', accept: ['On-site', 'Hybrid'] }],
      home_country: 'India',
      remote: {
        eligible_countries: ['India'],
        timezones: { acceptable: ['APAC'], borderline: ['EMEA'] },
      },
    },
    avoidMd: '# Avoid List\n\n- Chargebee\n- Rocketlane\n',
    resumeMeta: {
      core_skills: ['React', 'TypeScript'],
      secondary_skills: ['Vue.js'],
      target_seniority: ['Staff', 'Lead'],
    },
    greenhouseMd: undefined,
    kekaMd: undefined,
    ...overrides,
  };
}

// --- markdown parsing ---

test('parseAvoidMd: bullets before the alias-map heading are the avoid list', () => {
  const md = [
    '# Avoid List',
    '',
    'Companies to drop in Stage A. Matching normalizes both sides.',
    '',
    '- Chargebee',
    '- Rocketlane',
    '',
    '## Alias map (variant → canonical)',
    '- Tech M → Tech Mahindra',
  ].join('\n');
  const { avoid, aliases } = parseAvoidMd(md);
  assert.deepEqual(avoid, ['Chargebee', 'Rocketlane']);
  assert.deepEqual(aliases, ['Tech M → Tech Mahindra']);
});

test('parseAvoidMd: alias-map bullets never leak into the avoid list', () => {
  const { avoid } = parseAvoidMd('- A\n## Alias map\n- X → Y\n');
  assert.deepEqual(avoid, ['A']);
});

test('parseBoardsMd: reads Curated entries only, not Auto-discovered', () => {
  const md = [
    '# watchlist',
    '## Curated',
    '- Agoda - agoda',
    '- GitLab - gitlab',
    '',
    '## Auto-discovered',
    '- Sneaky - sneaky',
  ].join('\n');
  assert.deepEqual(parseBoardsMd(md), [
    { name: 'Agoda', token: 'agoda' },
    { name: 'GitLab', token: 'gitlab' },
  ]);
});

test('parseBoardsMd: splits on the LAST separator so hyphenated names survive', () => {
  assert.deepEqual(parseBoardsMd('## Curated\n- Tech - Mahindra - techm\n'), [
    { name: 'Tech - Mahindra', token: 'techm' },
  ]);
});

// --- profile.json merge ---

test('profile.json: every v0 key is preserved untouched alongside the v2 keys', () => {
  const { profileJson } = migrate(v0(), NOW);
  assert.equal(profileJson.notion_db_id, 'db-123');
  assert.equal(profileJson.notion_parent_page_id, 'page-456');
  assert.deepEqual(profileJson.notify, { telegram: { enabled: true, chat_id: '98765' } });
  // v0's schedule shape is left exactly as-is — it already parses as v2's.
  assert.deepEqual(profileJson.schedule, { enabled: true, times: ['09:00', '14:00'] });
});

test('profile.json: a legacy singular schedule.time is back-filled as times[], keeping time', () => {
  const inputs = v0();
  inputs.profile.schedule = { enabled: false, time: '09:00' };
  const { profileJson, warnings } = migrate(inputs, NOW);
  // `time` survives so v0 is untouched; `times` added so v2's schema parses.
  assert.deepEqual(profileJson.schedule, {
    enabled: false,
    time: '09:00',
    times: ['09:00'],
  });
  assert.ok(warnings.some((w) => w.includes('legacy singular time')));
});

test('profile.json: an existing times[] is never rewritten from time', () => {
  const inputs = v0();
  inputs.profile.schedule = { enabled: true, time: '09:00', times: ['11:30'] };
  const { profileJson } = migrate(inputs, NOW);
  assert.deepEqual(profileJson.schedule, {
    enabled: true,
    time: '09:00',
    times: ['11:30'],
  });
});

test('profile.json: lanes are linkedin-only when no boards files exist', () => {
  const { profileJson } = migrate(v0(), NOW);
  assert.deepEqual(profileJson.lanes, ['linkedin']);
});

test('profile.json: boards files add their lanes', () => {
  const { profileJson } = migrate(
    v0({
      greenhouseMd: '## Curated\n- Agoda - agoda\n',
      kekaMd: '## Curated\n- SurveySparrow - surveysparrow\n',
    }),
    NOW,
  );
  assert.deepEqual(profileJson.lanes, ['linkedin', 'greenhouse', 'keka']);
});

test('profile.json: a boards file with no curated entries does NOT add its lane', () => {
  const { profileJson } = migrate(
    v0({ greenhouseMd: '## Curated\n\n## Auto-discovered\n- X - x\n' }),
    NOW,
  );
  assert.deepEqual(profileJson.lanes, ['linkedin']);
});

test('profile.json: routines stays empty — v0 cleanup is not part of /run', () => {
  const { profileJson } = migrate(v0(), NOW);
  assert.deepEqual(profileJson.routines, []);
});

test('settings.notion: dryRun is always true, never silently flipped on', () => {
  const { profileJson } = migrate(v0(), NOW);
  assert.deepEqual(profileJson.settings.notion, { dbId: 'db-123', dryRun: true });
});

test('settings.notion: an empty v0 notion_db_id still emits the key, with a warning', () => {
  const inputs = v0();
  inputs.profile.notion_db_id = '';
  const { profileJson, warnings } = migrate(inputs, NOW);
  assert.deepEqual(profileJson.settings.notion, { dbId: '', dryRun: true });
  assert.ok(warnings.some((w) => w.includes('notion_db_id')));
});

test('settings.telegram: chat_id string becomes a number', () => {
  const { profileJson } = migrate(v0(), NOW);
  assert.deepEqual(profileJson.settings.telegram, { chatId: 98765 });
  assert.deepEqual(profileJson.notifiers, ['telegram']);
});

test('settings.telegram: disabled telegram drops both the notifier and the settings slice', () => {
  const inputs = v0();
  inputs.profile.notify = { telegram: { enabled: false, chat_id: '' } };
  const { profileJson } = migrate(inputs, NOW);
  assert.deepEqual(profileJson.notifiers, []);
  assert.equal('telegram' in profileJson.settings, false);
});

test('settings.telegram: a non-numeric chat_id warns instead of emitting NaN', () => {
  const inputs = v0();
  inputs.profile.notify = { telegram: { enabled: true, chat_id: 'not-a-number' } };
  const { profileJson, warnings } = migrate(inputs, NOW);
  assert.equal('telegram' in profileJson.settings, false);
  assert.ok(warnings.some((w) => w.includes('chat_id')));
});

test('settings.cleanup: pinned to the v0 archive policy defaults', () => {
  const { profileJson } = migrate(v0(), NOW);
  assert.deepEqual(profileJson.settings.cleanup, {
    passedOlderThanDays: 7,
    untouchedOlderThanDays: 30,
  });
});

// --- filter.json ---

test('filter.json: title rules carry allow/block into match/reject', () => {
  const { filterJson } = migrate(v0(), NOW);
  assert.deepEqual(filterJson.title?.seniority, {
    match: ['staff', 'lead'],
    reject: [],
    severity: 'hard',
  });
  assert.deepEqual(filterJson.title?.domain, {
    match: ['frontend', 'react'],
    reject: [],
    severity: 'hard',
  });
  assert.deepEqual(filterJson.title?.function, {
    match: ['engineer'],
    reject: ['manager', 'qa'],
    severity: 'hard',
  });
});

test('filter.json: work types normalize to the v2 lowercase enum', () => {
  const inputs = v0();
  inputs.filterConfig.locations = [
    { city: 'Chennai', country: 'India', accept: ['On-site', 'Hybrid', 'Remote'] },
  ];
  const { filterJson } = migrate(inputs, NOW);
  assert.deepEqual(filterJson.locations, [
    { city: 'Chennai', country: 'India', workTypes: ['onsite', 'hybrid', 'remote'] },
  ]);
});

test('filter.json: an unrecognized work type throws rather than silently dropping', () => {
  const inputs = v0();
  inputs.filterConfig.locations = [{ city: 'X', accept: ['Telepathic'] }];
  assert.throws(() => migrate(inputs, NOW), /Telepathic/);
});

test('filter.json: timezones are the acceptable+borderline union at hard severity', () => {
  const { filterJson } = migrate(v0(), NOW);
  assert.deepEqual(filterJson.timezones, { accept: ['APAC', 'EMEA'], severity: 'hard' });
});

test('filter.json: avoid.md becomes companies.avoid', () => {
  const { filterJson } = migrate(v0(), NOW);
  assert.deepEqual(filterJson.companies, { avoid: ['Chargebee', 'Rocketlane'] });
});

// --- rank config ---

test('settings.rank: populated from resume_meta and the v0 filter config', () => {
  const { profileJson } = migrate(v0(), NOW);
  const rank = profileJson.settings.rank as Record<string, Record<string, unknown>>;
  assert.deepEqual(rank.skills?.primary, ['React', 'TypeScript']);
  assert.deepEqual(rank.skills?.secondary, ['Vue.js']);
  assert.deepEqual(rank.seniority?.targets, ['Staff', 'Lead']);
  assert.deepEqual(rank.title?.domainKeywords, ['frontend', 'react']);
  assert.deepEqual(rank.location?.homeCities, ['Chennai']);
  // The acceptable/borderline tiering filter.json flattens is preserved here.
  assert.deepEqual(rank.location?.acceptableTimezones, ['APAC']);
  assert.deepEqual(rank.location?.borderlineTimezones, ['EMEA']);
  // Untouched axes keep their schema defaults.
  assert.equal(rank.yoe?.neutralPoints, 5);
});

test('settings.rank: seniority targets fall back to the v0 title filter', () => {
  const inputs = v0();
  inputs.resumeMeta = { core_skills: [], secondary_skills: [] };
  const { profileJson } = migrate(inputs, NOW);
  const rank = profileJson.settings.rank as Record<string, Record<string, unknown>>;
  assert.deepEqual(rank.seniority?.targets, ['staff', 'lead']);
});

// --- registry ---

test('registry: curated board entries become curated company records', () => {
  const { registry } = migrate(v0({ greenhouseMd: '## Curated\n- Agoda - agoda\n' }), NOW);
  assert.equal(registry?.length, 1);
  const rec = registry?.[0];
  assert.equal(rec?.name, 'Agoda');
  assert.equal(rec?.normalizedKey, 'agoda');
  assert.equal(rec?.curated, true);
  assert.deepEqual(rec?.seenBy, []);
  assert.equal(rec?.firstSeen, NOW);
  assert.deepEqual(rec?.probes.greenhouse, {
    status: 'found',
    boardRef: 'agoda',
    probedAt: NOW,
    failCount: 0,
  });
});

test('registry: a company on both watchlists yields ONE record with both probes', () => {
  const { registry } = migrate(
    v0({
      greenhouseMd: '## Curated\n- Acme Corp Pvt Ltd - acme\n',
      kekaMd: '## Curated\n- Acme Corp - acme-keka\n',
    }),
    NOW,
  );
  assert.equal(registry?.length, 1);
  assert.deepEqual(Object.keys(registry?.[0]?.probes ?? {}).sort(), ['greenhouse', 'keka']);
});

test('registry: no boards files means no registry file at all', () => {
  assert.equal(migrate(v0(), NOW).registry, undefined);
});

test('buildRegistry: is idempotent — rerunning yields identical records', () => {
  const entries = [{ name: 'Agoda', token: 'agoda' }];
  const a = buildRegistry({ greenhouse: entries, keka: [] }, NOW);
  const b = buildRegistry({ greenhouse: entries, keka: [] }, NOW);
  assert.deepEqual(a, b);
});

// --- unmapped reporting ---

test('unmapped: v0 fields with no v2 home are reported, never silently dropped', () => {
  const { unmapped } = migrate(
    v0({ avoidMd: '- A\n## Alias map\n- Tech M → Tech Mahindra\n' }),
    NOW,
  );
  const joined = unmapped.join('\n');
  assert.match(joined, /home_country/);
  assert.match(joined, /eligible_countries/);
  assert.match(joined, /alias map/i);
});

// --- idempotency ---

test('migrate: rerunning over its own output is a no-op on the v2 keys', () => {
  const first = migrate(v0(), NOW);
  const inputs = v0();
  // Simulate a second --write pass: profile.json now already carries v2 keys.
  inputs.profile = first.profileJson as unknown as V0Inputs['profile'];
  const second = migrate(inputs, NOW);
  assert.deepEqual(second.profileJson, first.profileJson);
});
