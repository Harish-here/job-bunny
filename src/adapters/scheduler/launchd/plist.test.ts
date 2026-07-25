/**
 * plist.test.ts — TDD for buildPlists: pure XML/plist generation from
 * ScheduledJob[], no I/O. Assert on meaningful substrings/structure per
 * the task brief — the watchdog bash is a string; don't brittle-match the
 * entire blob.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduledJob } from '../../../ports/scheduler.ts';
import { buildPlists } from './plist.ts';

const ROOT = '/repo';
const HOME = '/Users/tester';

function jobs(...pairs: Array<[string, string]>): ScheduledJob[] {
  return pairs.map(([profile, time]) => ({ profile, time }));
}

test('buildPlists: one plist per distinct time', () => {
  const result = buildPlists(
    jobs(['rajni', '09:00'], ['harish', '09:00'], ['rajni', '17:30']),
    {
      root: ROOT,
      home: HOME,
    },
  );
  assert.equal(result.length, 2);
  const times = result.map((p) => p.time).sort();
  assert.deepEqual(times, ['09:00', '17:30']);
});

test('buildPlists: multiple profiles at the same time share one plist', () => {
  const result = buildPlists(jobs(['rajni', '09:00'], ['harish', '09:00']), {
    root: ROOT,
    home: HOME,
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.profiles, ['rajni', 'harish']);
});

test('buildPlists: label format strips the colon from HH:MM', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  assert.equal(result[0]?.label, 'com.jobbunny.0900');
});

test('buildPlists: label reflects a non-round time correctly', () => {
  const result = buildPlists(jobs(['rajni', '17:30']), { root: ROOT, home: HOME });
  assert.equal(result[0]?.label, 'com.jobbunny.1730');
});

test('buildPlists: profiles are chained in input order in the command', () => {
  const result = buildPlists(jobs(['zeta', '09:00'], ['alpha', '09:00']), {
    root: ROOT,
    home: HOME,
  });
  const cmd = result[0]?.xml ?? '';
  const zetaIdx = cmd.indexOf('--profile zeta');
  const alphaIdx = cmd.indexOf('--profile alpha');
  assert.ok(zetaIdx >= 0 && alphaIdx >= 0);
  assert.ok(zetaIdx < alphaIdx, 'zeta (input order) should appear before alpha');
});

test('buildPlists: each profile invocation is jobbunny run --profile <p> --headless', () => {
  const result = buildPlists(jobs(['rajni', '09:00'], ['harish', '09:00']), {
    root: ROOT,
    home: HOME,
  });
  const xml = result[0]?.xml ?? '';
  assert.match(xml, /jobbunny run --profile rajni --headless/);
  assert.match(xml, /jobbunny run --profile harish --headless/);
});

test('buildPlists: cd into the repo root before running profiles', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  // Single quotes are XML-escaped (&apos;) since this substring lives inside
  // a <string> element's text content.
  const cdIdx = xml.indexOf(`cd &apos;${ROOT}&apos;`);
  const runIdx = xml.indexOf('jobbunny run --profile rajni --headless');
  assert.ok(cdIdx >= 0, 'expected a cd into ROOT');
  assert.ok(cdIdx < runIdx, 'cd must happen before the profile run');
});

test('buildPlists: one profile failing does not abort the others (semicolon-joined, not &&)', () => {
  const result = buildPlists(jobs(['rajni', '09:00'], ['harish', '09:00']), {
    root: ROOT,
    home: HOME,
  });
  const xml = result[0]?.xml ?? '';
  assert.match(
    xml,
    /jobbunny run --profile rajni --headless; jobbunny run --profile harish --headless/,
  );
});

test('buildPlists: default backstopSeconds is runCapMs(16_200_000)/1000 + 300 = 16500', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  assert.match(xml, /\b16500\b/);
});

// The DEFAULT_RUN_CAP_MS-vs-derived-run-cap invariant used to be guarded
// here with a hand-copied literal (`PRODUCTION_RUN_CAP_MS = 13_012_500`)
// that nothing re-derived when a stage's `timeoutMs`/`retries` changed —
// adapters may not import `cli` (`nothing-imports-cli`), so this file
// could never check the real value, only a stale copy of it. The live
// invariant — computed from the real wired stage table via `wire()` +
// `computeRunCapMs`, not a literal — now lives in
// `test/invariants/run_cap_backstop.test.ts` (outside `src/`, the one
// place a test may legally import both `cli` and `adapters`; see that
// file's header for why `.dependency-cruiser.cjs` permits it).

test('buildPlists: custom runCapMs changes the backstopSeconds value (ceil + 300)', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), {
    root: ROOT,
    home: HOME,
    runCapMs: 60_500, // ceil(60.5s) = 61 -> +300 = 361
  });
  const xml = result[0]?.xml ?? '';
  assert.match(xml, /\b361\b/);
});

test('buildPlists: SIGTERM appears before SIGKILL in the watchdog command', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  const termIdx = xml.indexOf('SIGTERM');
  const killIdx = xml.indexOf('SIGKILL');
  assert.ok(termIdx >= 0 && killIdx >= 0);
  assert.ok(termIdx < killIdx);
});

test('buildPlists: StartCalendarInterval has one dict per weekday 1..5 with correct Hour/Minute', () => {
  const result = buildPlists(jobs(['rajni', '17:05']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  for (const weekday of [1, 2, 3, 4, 5]) {
    assert.match(
      xml,
      new RegExp(
        `<key>Weekday</key>\\s*<integer>${weekday}</integer>\\s*<key>Hour</key>\\s*<integer>17</integer>\\s*<key>Minute</key>\\s*<integer>5</integer>`,
      ),
    );
  }
  assert.doesNotMatch(xml, /<integer>0<\/integer>\s*<key>Hour/); // no Sunday(0)/Saturday(6) entries
  assert.doesNotMatch(xml, /<integer>6<\/integer>\s*<key>Hour/);
});

test('buildPlists: RunAtLoad is false', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
});

test('buildPlists: WorkingDirectory is the repo root', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  assert.match(
    xml,
    new RegExp(`<key>WorkingDirectory</key>\\s*<string>${ROOT}</string>`),
  );
});

test('buildPlists: log paths expand home under ~/Library/Logs/JobBunny/<label>', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  assert.match(
    xml,
    new RegExp(
      `<key>StandardOutPath</key>\\s*<string>${HOME}/Library/Logs/JobBunny/com\\.jobbunny\\.0900\\.out\\.log</string>`,
    ),
  );
  assert.match(
    xml,
    new RegExp(
      `<key>StandardErrorPath</key>\\s*<string>${HOME}/Library/Logs/JobBunny/com\\.jobbunny\\.0900\\.err\\.log</string>`,
    ),
  );
});

test('buildPlists: Label key matches the plist entry label', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.jobbunny\.0900<\/string>/);
});

test('buildPlists: ProgramArguments starts with /bin/bash -lc', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  assert.match(
    xml,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/bin\/bash<\/string>\s*<string>-lc<\/string>/,
  );
});

test('buildPlists: xml has a plist doctype/root wrapper', () => {
  const result = buildPlists(jobs(['rajni', '09:00']), { root: ROOT, home: HOME });
  const xml = result[0]?.xml ?? '';
  assert.match(xml, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist PUBLIC/);
  assert.match(xml, /^<plist version="1\.0">/m);
  assert.match(xml, /<\/plist>\s*$/);
});

test('buildPlists: throws on a malformed time string', () => {
  assert.throws(() => buildPlists(jobs(['rajni', '9:00']), { root: ROOT, home: HOME }));
  assert.throws(() => buildPlists(jobs(['rajni', '25:00']), { root: ROOT, home: HOME }));
  assert.throws(() => buildPlists(jobs(['rajni', 'nope']), { root: ROOT, home: HOME }));
});

test('buildPlists: empty jobs list returns an empty array', () => {
  const result = buildPlists([], { root: ROOT, home: HOME });
  assert.deepEqual(result, []);
});
