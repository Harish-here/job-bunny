/**
 * profile.test.ts (P8) — TDD for `profileBuildCommand` (seed-never-
 * clobber, idempotent, schema-validated) and `profileRemoveCommand`
 * (dry-run unless --force). All against a temp root, never the real
 * `profiles/`.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import { profileBuildCommand, profileRemoveCommand } from './profile.ts';

async function withTmpRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'jobbunny-profile-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('profileBuildCommand creates the profile dir and seeds all four scaffold files as valid schema instances', async () => {
  await withTmpRoot(async (root) => {
    const lines: string[] = [];
    const code = await profileBuildCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 0);

    const profileDir = path.join(root, 'profiles', 'acme');
    const pipelineRaw = await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    const filterRaw = await readFile(path.join(profileDir, 'filter.json'), 'utf8');
    assert.doesNotThrow(() => PipelineConfigSchema.parse(JSON.parse(pipelineRaw)));
    assert.doesNotThrow(() => FilterConfigSchema.parse(JSON.parse(filterRaw)));

    await readFile(path.join(profileDir, 'search_urls.md'), 'utf8');
    await readFile(path.join(profileDir, 'avoid.md'), 'utf8');

    assert.equal(lines.filter((l) => l.includes(': created')).length, 4);
  });
});

test('profileBuildCommand leaves an existing file byte-for-byte untouched and reports it as kept', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'acme');
    await mkdir(profileDir, { recursive: true });
    const customProfileJson = JSON.stringify(
      { lanes: ['linkedin'], connector: 'notion' },
      null,
      2,
    );
    await writeFile(path.join(profileDir, 'profile.json'), customProfileJson);

    const lines: string[] = [];
    await profileBuildCommand({ profile: 'acme' }, { root, write: (l) => lines.push(l) });

    const after = await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    assert.equal(after, customProfileJson);
    assert.ok(lines.some((l) => l.includes('profile.json') && l.includes(': kept')));
  });
});

test('profileBuildCommand is idempotent: a second run creates nothing', async () => {
  await withTmpRoot(async (root) => {
    await profileBuildCommand({ profile: 'acme' }, { root, write: () => {} });
    const lines: string[] = [];
    await profileBuildCommand({ profile: 'acme' }, { root, write: (l) => lines.push(l) });
    assert.equal(lines.filter((l) => l.includes(': created')).length, 0);
    assert.equal(lines.filter((l) => l.includes(': kept')).length, 4);
  });
});

test('profileRemoveCommand without --force prints a summary and returns non-zero without touching anything', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'acme');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'profile.json'), '{}');

    const lines: string[] = [];
    const code = await profileRemoveCommand(
      { profile: 'acme' },
      { root, write: (l) => lines.push(l) },
    );
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes('would remove')));

    const stillThere = await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    assert.equal(stillThere, '{}');
  });
});

test('profileRemoveCommand with --force deletes the profile directory', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'acme');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'profile.json'), '{}');

    const code = await profileRemoveCommand(
      { profile: 'acme', force: true },
      { root, write: () => {} },
    );
    assert.equal(code, 0);

    let exists = true;
    try {
      await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    } catch {
      exists = false;
    }
    assert.equal(exists, false);
  });
});

test('profileRemoveCommand returns non-zero when the profile does not exist', async () => {
  await withTmpRoot(async (root) => {
    const code = await profileRemoveCommand(
      { profile: 'ghost', force: true },
      { root, write: () => {} },
    );
    assert.equal(code, 1);
  });
});

test('profileRemoveCommand refuses to remove the "rajni" fixture profile even with --force', async () => {
  await withTmpRoot(async (root) => {
    const profileDir = path.join(root, 'profiles', 'rajni');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'profile.json'), '{}');

    const code = await profileRemoveCommand(
      { profile: 'rajni', force: true },
      { root, write: () => {} },
    );
    assert.equal(code, 1);
    const stillThere = await readFile(path.join(profileDir, 'profile.json'), 'utf8');
    assert.equal(stillThere, '{}');
  });
});
