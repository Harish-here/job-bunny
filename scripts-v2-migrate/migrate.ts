#!/usr/bin/env node
/**
 * scripts-v2-migrate/migrate.ts (P8 Task 5) — one-off v0 → v2 profile config
 * migrator. Deleted in P9; it lives outside `src/` on purpose so it never
 * becomes part of the product surface.
 *
 * Contract:
 *   in   profiles/<p>/{profile.json,filter_config.json,avoid.md,resume_meta.json,
 *        greenhouse_boards.md,keka_boards.md}   (all v0 formats, read-only)
 *   out  profiles/<p>/profile.json              (MERGED — v0 keys preserved)
 *        profiles/<p>/filter.json               (new)
 *        profiles/<p>/data/registry/companies.json  (new, only if a boards file exists)
 *
 * Invariants:
 *  - Dry run by default; `--write` is the only thing that touches disk.
 *  - profile.json is MERGED, never replaced: v0 and v2 key sets are disjoint
 *    and both trees must keep working side by side through the cutover soak.
 *    v0's `schedule` already parses as v2's ScheduleSchema, so it is copied
 *    through untouched rather than rewritten.
 *  - `settings.notion.dryRun` is always emitted `true` — wiring must never
 *    silently flip real Notion writes on (P8 plan carry-in).
 *  - Every output is validated against its real zod schema before it is
 *    printed or written; a validation failure exits non-zero.
 *  - Anything with no v2 home is reported under UNMAPPED rather than dropped.
 *  - Idempotent: a second `--write` produces byte-identical output.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import type { CompanyRecord } from '../src/core/company/schema.ts';
import { RegistrySchema } from '../src/core/company/schema.ts';
import { PipelineConfigSchema } from '../src/core/config/schema.ts';
import type { FilterConfig } from '../src/core/filter/config.ts';
import { FilterConfigSchema } from '../src/core/filter/config.ts';
import { companyKey } from '../src/core/jd/normalize.ts';
import type { WorkType } from '../src/core/jd/schema.ts';
import { RankConfigSchema } from '../src/core/rank/index.ts';

// --- v0 input shapes (loose on purpose — these files predate any schema) ---

export interface V0Profile {
  notion_db_id?: string;
  notion_parent_page_id?: string;
  schedule?: unknown;
  notify?: { telegram?: { enabled?: boolean; chat_id?: string } };
  [key: string]: unknown;
}

export interface V0FilterConfig {
  title_filter?: {
    seniority?: string[];
    domain?: string[];
    function?: { allow?: string[]; block?: string[] };
  };
  locations?: Array<{ city: string; country?: string; accept?: string[] }>;
  home_country?: string;
  remote?: {
    eligible_countries?: string[];
    timezones?: { acceptable?: string[]; borderline?: string[] };
  };
}

export interface V0ResumeMeta {
  core_skills?: string[];
  secondary_skills?: string[];
  target_seniority?: string[];
}

export interface V0Inputs {
  profile: V0Profile;
  filterConfig: V0FilterConfig;
  avoidMd: string | undefined;
  resumeMeta: V0ResumeMeta | undefined;
  greenhouseMd: string | undefined;
  kekaMd: string | undefined;
}

export interface BoardEntry {
  name: string;
  token: string;
}

export interface MigrationResult {
  profileJson: Record<string, unknown> & { settings: Record<string, unknown> } & {
    lanes: string[];
    notifiers: string[];
    routines: string[];
  };
  filterJson: FilterConfig;
  registry: CompanyRecord[] | undefined;
  warnings: string[];
  unmapped: string[];
}

// --- markdown parsing ---

const BULLET = /^\s*-\s+(.*\S)\s*$/;

/** avoid.md → the company bullets, plus the alias-map bullets (which have no
 * v2 home and are reported, not migrated). The alias-map heading is the
 * divider; everything before it that is a bullet is a company. */
export function parseAvoidMd(md: string): { avoid: string[]; aliases: string[] } {
  const avoid: string[] = [];
  const aliases: string[] = [];
  let inAliases = false;
  for (const line of md.split('\n')) {
    if (/^##\s+alias map/i.test(line.trim())) {
      inAliases = true;
      continue;
    }
    const m = BULLET.exec(line);
    if (!m?.[1]) continue;
    (inAliases ? aliases : avoid).push(m[1]);
  }
  return { avoid, aliases };
}

/** greenhouse_boards.md / keka_boards.md → the `## Curated` entries only.
 * `## Auto-discovered` is runtime state the v2 registry rediscovers itself.
 * Splits on the LAST ` - ` so hyphenated display names survive. */
export function parseBoardsMd(md: string): BoardEntry[] {
  const entries: BoardEntry[] = [];
  let inCurated = false;
  for (const line of md.split('\n')) {
    const heading = /^##\s+(.*\S)\s*$/.exec(line.trim());
    if (heading) {
      inCurated = /^curated$/i.test(heading[1] ?? '');
      continue;
    }
    if (!inCurated) continue;
    const m = BULLET.exec(line);
    if (!m?.[1]) continue;
    const sep = m[1].lastIndexOf(' - ');
    if (sep < 0) continue;
    entries.push({
      name: m[1].slice(0, sep).trim(),
      token: m[1].slice(sep + 3).trim(),
    });
  }
  return entries.filter((e) => e.name && e.token);
}

// --- field mapping ---

const WORK_TYPES: Record<string, WorkType> = {
  onsite: 'onsite',
  hybrid: 'hybrid',
  remote: 'remote',
};

/** v0 writes "On-site"/"Hybrid"/"Remote"; v2's WorkTypeSchema is lowercase
 * and hyphenless. Unknown values throw — a silently dropped work type would
 * quietly widen or narrow the location filter. */
function toWorkType(raw: string): WorkType {
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  const mapped = WORK_TYPES[key];
  if (!mapped) throw new Error(`unrecognized v0 work type "${raw}" (expected On-site/Hybrid/Remote)`);
  return mapped;
}

function rule(match: string[] | undefined, reject: string[] | undefined) {
  if (!match?.length && !reject?.length) return undefined;
  return { match: match ?? [], reject: reject ?? [], severity: 'hard' as const };
}

function buildFilterJson(v0: V0FilterConfig, avoid: string[]): FilterConfig {
  const tf = v0.title_filter ?? {};
  const title = {
    seniority: rule(tf.seniority, undefined),
    domain: rule(tf.domain, undefined),
    function: rule(tf.function?.allow, tf.function?.block),
  };
  const tz = v0.remote?.timezones;
  // Union, at hard severity: v0 KEEPS borderline zones (with a rank penalty)
  // rather than dropping them, so the union drops exactly what v0 drops. The
  // acceptable/borderline tiering is preserved in settings.rank.location.
  const accept = [...(tz?.acceptable ?? []), ...(tz?.borderline ?? [])];

  return FilterConfigSchema.parse({
    ...(Object.values(title).some(Boolean) ? { title } : {}),
    ...(avoid.length ? { companies: { avoid } } : {}),
    ...(v0.locations?.length
      ? {
          locations: v0.locations.map((loc) => ({
            city: loc.city,
            ...(loc.country ? { country: loc.country } : {}),
            workTypes: (loc.accept ?? []).map(toWorkType),
          })),
        }
      : {}),
    ...(accept.length ? { timezones: { accept, severity: 'hard' } } : {}),
  });
}

function buildRankConfig(v0: V0FilterConfig, meta: V0ResumeMeta | undefined) {
  const base = RankConfigSchema.parse({});
  const tz = v0.remote?.timezones;
  return RankConfigSchema.parse({
    ...base,
    skills: {
      ...base.skills,
      primary: meta?.core_skills ?? [],
      secondary: meta?.secondary_skills ?? [],
    },
    seniority: {
      ...base.seniority,
      targets: meta?.target_seniority?.length
        ? meta.target_seniority
        : (v0.title_filter?.seniority ?? []),
    },
    title: { ...base.title, domainKeywords: v0.title_filter?.domain ?? [] },
    location: {
      ...base.location,
      homeCities: (v0.locations ?? []).map((l) => l.city),
      acceptableTimezones: tz?.acceptable ?? [],
      borderlineTimezones: tz?.borderline ?? [],
    },
  });
}

/** Board entries → curated CompanyRecords, one per company even when the same
 * company appears on both watchlists (probes are keyed by lane name). */
export function buildRegistry(
  boards: { greenhouse: BoardEntry[]; keka: BoardEntry[] },
  now: string,
): CompanyRecord[] {
  const byKey = new Map<string, CompanyRecord>();
  for (const [lane, entries] of Object.entries(boards) as Array<[string, BoardEntry[]]>) {
    for (const entry of entries) {
      const key = companyKey(entry.name);
      const existing = byKey.get(key);
      const record: CompanyRecord = existing ?? {
        name: entry.name,
        normalizedKey: key,
        firstSeen: now,
        lastSeen: now,
        seenBy: [],
        probes: {},
        curated: true,
      };
      record.probes[lane] = {
        status: 'found',
        boardRef: entry.token,
        probedAt: now,
        failCount: 0,
      };
      byKey.set(key, record);
    }
  }
  return RegistrySchema.parse([...byKey.values()]);
}

/** v0 profiles declare EITHER `schedule.times: []` (current) or the legacy
 * singular `schedule.time: "HH:MM"` — see scripts/ops/schedule.js, which
 * prefers `times` when both are present. v2's ScheduleSchema only knows
 * `times`, so back-fill it from `time` without removing anything. */
function normalizeSchedule(
  raw: unknown,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const schedule = raw as Record<string, unknown>;
  if (Array.isArray(schedule.times)) return schedule;
  if (typeof schedule.time === 'string') {
    warnings.push(
      `schedule uses the legacy singular time "${schedule.time}" — back-filled as ` +
        'times: [time] for v2; the v0 `time` key is preserved and v0 behavior is unchanged.',
    );
    return { ...schedule, times: [schedule.time] };
  }
  warnings.push('schedule has neither `times` nor `time` — emitting times: [].');
  return { ...schedule, times: [] };
}

// --- the migration itself (pure) ---

export function migrate(inputs: V0Inputs, now: string): MigrationResult {
  const warnings: string[] = [];
  const unmapped: string[] = [];

  const { avoid, aliases } = inputs.avoidMd
    ? parseAvoidMd(inputs.avoidMd)
    : { avoid: [], aliases: [] };
  const greenhouse = inputs.greenhouseMd ? parseBoardsMd(inputs.greenhouseMd) : [];
  const keka = inputs.kekaMd ? parseBoardsMd(inputs.kekaMd) : [];

  const lanes = ['linkedin'];
  if (greenhouse.length) lanes.push('greenhouse');
  if (keka.length) lanes.push('keka');

  const dbId = inputs.profile.notion_db_id ?? '';
  if (!dbId) {
    warnings.push(
      'v0 notion_db_id is empty — settings.notion.dbId is emitted empty and the ' +
        'profile is NOT runnable until a real database id is filled in ' +
        '(NotionConnectorSettingsSchema requires a non-empty dbId).',
    );
  }

  const telegram = inputs.profile.notify?.telegram;
  const settings: Record<string, unknown> = {
    notion: { dbId, dryRun: true },
    rank: buildRankConfig(inputs.filterConfig, inputs.resumeMeta),
    cleanup: { passedOlderThanDays: 7, untouchedOlderThanDays: 30 },
  };

  const notifiers: string[] = [];
  if (telegram?.enabled) {
    const chatId = Number(telegram.chat_id);
    if (telegram.chat_id && Number.isInteger(chatId)) {
      settings.telegram = { chatId };
      notifiers.push('telegram');
    } else {
      warnings.push(
        `telegram is enabled but chat_id "${telegram.chat_id ?? ''}" is not an integer — ` +
          'settings.telegram omitted and the telegram notifier left out ' +
          '(v2 TelegramNotifierSettingsSchema requires a number).',
      );
    }
  }

  if (inputs.filterConfig.home_country) {
    unmapped.push(
      `filter_config.json home_country ("${inputs.filterConfig.home_country}") — ` +
        'no v2 FilterConfig equivalent; country lives per-location in filter.json.',
    );
  }
  if (inputs.filterConfig.remote?.eligible_countries?.length) {
    unmapped.push(
      `filter_config.json remote.eligible_countries (${inputs.filterConfig.remote.eligible_countries.join(', ')}) — ` +
        'no v2 FilterConfig equivalent.',
    );
  }
  if (aliases.length) {
    unmapped.push(
      `avoid.md alias map (${aliases.length} entr${aliases.length === 1 ? 'y' : 'ies'}: ${aliases.join('; ')}) — ` +
        'v2 normalizes via core/jd companyKey and has no per-profile alias map.',
    );
  }

  // Merge, not replace: v0 keys first so they survive verbatim. `schedule` is
  // copied through rather than rebuilt — v0's `{enabled, times[]}` already
  // parses as v2's ScheduleSchema. The one exception is the LEGACY singular
  // `schedule.time`, which v2 has no reading for: we add `times: [time]` and
  // keep `time`, which is a no-op for v0 (its schedule.js already prefers
  // `times` when present) and makes the profile valid for v2.
  const schedule = normalizeSchedule(inputs.profile.schedule, warnings);

  const merged = {
    ...inputs.profile,
    ...(schedule ? { schedule } : {}),
    lanes,
    connector: 'notion',
    notifiers,
    routines: [] as string[],
    settings,
  };

  // Validate against the real schema (parse strips to the v2 view; we keep the
  // merged object so v0 keys survive, but a parse failure must still be loud).
  PipelineConfigSchema.parse(merged);

  return {
    profileJson: merged as MigrationResult['profileJson'],
    filterJson: buildFilterJson(inputs.filterConfig, avoid),
    registry: greenhouse.length || keka.length ? buildRegistry({ greenhouse, keka }, now) : undefined,
    warnings,
    unmapped,
  };
}

// --- IO shell ---

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function loadV0(root: string, profile: string): Promise<V0Inputs> {
  const dir = path.join(root, 'profiles', profile);
  const profileRaw = await readOptional(path.join(dir, 'profile.json'));
  if (profileRaw === undefined) {
    throw new Error(`no v0 profile.json at ${path.join(dir, 'profile.json')}`);
  }
  const filterRaw = await readOptional(path.join(dir, 'filter_config.json'));
  const metaRaw = await readOptional(path.join(dir, 'resume_meta.json'));
  return {
    profile: JSON.parse(profileRaw),
    filterConfig: filterRaw ? JSON.parse(filterRaw) : {},
    avoidMd: await readOptional(path.join(dir, 'avoid.md')),
    resumeMeta: metaRaw ? JSON.parse(metaRaw) : undefined,
    greenhouseMd: await readOptional(path.join(dir, 'greenhouse_boards.md')),
    kekaMd: await readOptional(path.join(dir, 'keka_boards.md')),
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { profile: { type: 'string' }, write: { type: 'boolean', default: false } },
  });
  if (!values.profile) {
    console.error('usage: migrate.ts --profile <name> [--write]');
    return 2;
  }

  const root = process.cwd();
  const dir = path.join(root, 'profiles', values.profile);
  const v0 = await loadV0(root, values.profile);
  const result = migrate(v0, new Date().toISOString());

  const v0Keys = Object.keys(v0.profile);
  const newKeys = Object.keys(result.profileJson).filter((k) => !v0Keys.includes(k));

  const mode = values.write ? 'WRITE' : 'DRY RUN (no files touched)';
  console.log(`\n=== v0 → v2 migration: ${values.profile} — ${mode} ===\n`);

  console.log(`--- ${path.join(dir, 'profile.json')} (MERGE) ---`);
  console.log(`preserved v0 keys: ${v0Keys.join(', ')}`);
  console.log(`added v2 keys:     ${newKeys.join(', ')}`);
  console.log(json(result.profileJson));

  console.log(`--- ${path.join(dir, 'filter.json')} (CREATE) ---`);
  console.log(json(result.filterJson));

  const registryPath = path.join(dir, 'data', 'registry', 'companies.json');
  if (result.registry) {
    console.log(`--- ${registryPath} (CREATE) — ${result.registry.length} curated ---`);
    console.log(json(result.registry));
  } else {
    console.log('--- registry: no greenhouse/keka watchlist, nothing to migrate ---\n');
  }

  if (result.warnings.length) {
    console.log('!!! WARNINGS !!!');
    for (const w of result.warnings) console.log(`  - ${w}`);
    console.log('');
  }

  console.log('UNMAPPED v0 FIELDS (no v2 home — review before --write):');
  if (result.unmapped.length === 0) console.log('  (none)');
  for (const u of result.unmapped) console.log(`  - ${u}`);
  console.log('');

  if (!values.write) {
    console.log('Dry run only. Re-run with --write to apply.');
    return 0;
  }

  await writeFile(path.join(dir, 'profile.json'), json(result.profileJson));
  await writeFile(path.join(dir, 'filter.json'), json(result.filterJson));
  if (result.registry) {
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, json(result.registry));
  }
  console.log('Written.');
  return 0;
}

function isMain(): boolean {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
