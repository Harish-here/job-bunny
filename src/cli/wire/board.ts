/**
 * cli/wire/board.ts (local-DB spec PR 4, Task 7; config→db Phase 4, Task 5)
 * — the board server's own composition point: sibling to
 * `compose.ts`/`builders.ts` in the `only-wire-imports-adapters` carve-out
 * (`.dependency-cruiser.cjs`), the ONE place a `BoardSource` is assembled
 * from real sqlite adapters. `wireBoard` is built once, at CLI-command time
 * (Task 8's `board` command); `createBoardServer` (Task 6) is the only
 * thing that calls `listProfiles`/`openStore` afterward, once per request.
 *
 * `listProfiles`/`openStore` are `async` (`ports/board.ts`'s own doc
 * comment): probing a profile's `connector` field reads `profile.json`
 * through a short-lived, READONLY `SqliteConfigStore` (`wireConfigStore`,
 * `builders.ts`) rather than a raw `readFileSync` — `db path` is now the
 * SAME canonical path `canonicalDbPath` produces everywhere else, no
 * settings-based override exists to disagree about (`settings.sqlite.path`
 * is retired).
 *
 * Tolerant posture: a broken profile probe (missing db AND missing legacy
 * file, a corrupt db, a malformed JSON string, a `connector` field of the
 * wrong type — ANY failure of the whole store-construction+read+parse
 * probe) never kills discovery — `listProfiles` degrades that profile to
 * `{ name, connector: '', hasDb }` rather than throwing, the same posture
 * the pipeline's own doctor takes on a bad profile. The short-lived probe
 * store is ALWAYS closed in a `finally`, never memoized, mirroring
 * `wireDaemonRunHistory`'s (`daemon.ts`) own discipline.
 *
 * `openStore`'s three gates are SECURITY-ORDERED and must stay in this
 * order:
 *   1. `name` membership against the CURRENT `listProfiles()` result,
 *      compared with `===` — THIS is the traversal defense, not
 *      `path.normalize`/`path.resolve` or a `startsWith(root)` check.
 *      `name` arrives straight from a URL path param that `matchRoute`
 *      decodes (`%2F` included), so `'../rajni'` or `'a/../a'` are
 *      genuinely reachable inputs; neither ever equals a real directory
 *      name read off disk, so the membership check rejects them outright
 *      without needing to reason about path math at all.
 *   2. `hasDb` must be true, else null. `openJobsDb` would mkdir+create a
 *      missing file — the board reads and annotates, it never
 *      initializes a database.
 *   3. Only past both gates: `new SqliteBoardStore(openJobsDb(dbPath))`,
 *      memoized per name for the life of this `BoardSource`.
 * `openStore` MAY throw past the gates (corrupt file, schema newer than
 * this build supports) — that is intentional and documented on
 * `ports/board.ts`'s `openStore`; the caller (the board server's
 * catch-all) turns it into a 500, never a crash.
 *
 * Discovery is at-call: every `listProfiles()` (and every `openStore`,
 * which re-derives its own membership list) re-reads `<root>/profiles`
 * from disk, so a profile created while the server is running appears on
 * the next call. The store memo is unaffected by that — it survives until
 * `close()`.
 *
 * `readConfigDoc`/`writeConfigDoc`/`createProfile` (config→db Phase 4,
 * Task 9 — the hard-rule amendment, ledger L7, `ports/board.ts`'s own doc
 * comment carries the pinned wording) each construct their OWN short-lived
 * `ConfigStore` via `wireConfigStore` and always `close()` it in a
 * `finally` — none of the three ever touches the `stores` memo above.
 * `readConfigDoc` re-derives membership and is readonly (never creates a
 * db as a side effect of a GET); `writeConfigDoc` re-derives membership
 * and is readwrite (writing is the meaningful first use allowed to create
 * one); `createProfile` checks the name FORMAT before ever re-deriving
 * membership or touching the filesystem, then delegates entirely to
 * `seedProfileDocs` (`../commands/profile.ts` — a cli-to-cli import, not a
 * boundary violation; only `app`↔`cli` and non-wire-cli↔`adapters` are
 * restricted, never cli-internal imports).
 */
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { chmod as fsChmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  openJobsDb,
  SqliteBoardStore,
  SqliteRunIntentStore,
} from '../../adapters/db/sqlite/index.ts';
import { hasEnvValue, upsertEnvLine } from '../../core/env_file/index.ts';
import {
  type BoardProfile,
  type BoardSource,
  type BoardStore,
  type DaemonStatus,
  type RemoveProfileOutcome,
  SECRET_KEYS,
  type SecretKey,
  type SecretPresence,
} from '../../ports/board.ts';
import type { ConfigDocKey } from '../../ports/config_store.ts';
import type { DoctorReport } from '../../ports/doctor.ts';
import type { RunIntentStore } from '../../ports/run_intents.ts';
import { PROTECTED_PROFILES, seedProfileDocs } from '../commands/profile.ts';
import { resolveHome } from '../home/index.ts';
import { readBoardDaemonStatus } from './board_daemon.ts';
import { runBoardDoctor } from './board_doctor.ts';
import { canonicalDbPath, wireConfigStore } from './builders.ts';

const PROFILE_NAME_RE = /^[a-z0-9_-]+$/;

export interface BoardWireOverrides {
  /** the data home; default `resolveHome()` — same resolution as
   * `compose.ts`/`wireMigrate` in `builders.ts`. */
  root?: string;
  /** test-only seam: overrides how `.env` is chmod'd to `0o600` after
   * `writeSecret` writes it. Default calls the real `node:fs/promises`
   * `chmod`. Tests use this to assert the call happened (path + mode)
   * without depending on the host OS actually honoring the permission
   * bits. */
  chmodEnvFile?: (path: string, mode: number) => Promise<void>;
}

interface ProfileInfo extends BoardProfile {
  dbPath: string;
}

/** The single authoritative db path for every profile, regardless of
 * `connector` (config→db Phase 4 — `settings.sqlite.path` is retired). */
function resolveDbPath(root: string, name: string): string {
  return canonicalDbPath(root, name);
}

/** `<root>/.env`'s current text, UTF-8. A missing file (ENOENT) reads as
 * the empty string, not an error — same tolerant posture as every other
 * "file may not exist yet" read in this module. */
async function readEnvText(root: string): Promise<string> {
  try {
    return await readFile(path.join(root, '.env'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Reads `profile.json`'s `connector` field through a short-lived,
 * readonly `ConfigStore` (never creates or migrates `jobbunny.db` as a
 * side effect of discovery). ANY failure of the whole probe — store
 * construction, `readText`, `JSON.parse`, or a `connector` field of the
 * wrong type — degrades to `''`, the same tolerant posture the old direct
 * file read had. */
async function readProfileInfo(root: string, name: string): Promise<ProfileInfo> {
  const dbPath = resolveDbPath(root, name);
  let connector = '';
  const store = wireConfigStore(name, { root, liftMode: 'readonly' });
  try {
    const raw = await store.readText('profile.json');
    if (raw !== undefined) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { connector?: unknown }).connector === 'string'
      ) {
        connector = (parsed as { connector: string }).connector;
      }
    }
  } catch {
    // missing DB + missing legacy file, a corrupt DB, malformed JSON, or a
    // wrongly-typed `connector` field — tolerant posture, degrade to ''.
  } finally {
    store.close();
  }
  return { name, connector, hasDb: existsSync(dbPath), dbPath };
}

/** `<root>/profiles`, directories only, sorted. A missing `profiles/`
 * directory itself yields `[]` rather than throwing — the same fail-soft
 * shape `scanProfileSchedules` (ops/daemon/scan) already uses. */
async function listProfileInfos(root: string): Promise<ProfileInfo[]> {
  let entries: Dirent[];
  try {
    entries = readdirSync(path.join(root, 'profiles'), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map((name) => readProfileInfo(root, name)));
}

export function wireBoard(overrides: BoardWireOverrides = {}): BoardSource {
  const root = overrides.root ?? resolveHome();
  const chmodEnvFile = overrides.chmodEnvFile ?? fsChmod;
  const stores = new Map<string, BoardStore>();
  const intentStores = new Map<string, RunIntentStore>();

  return {
    async listProfiles(): Promise<BoardProfile[]> {
      const infos = await listProfileInfos(root);
      return infos.map(({ name, connector, hasDb }) => ({ name, connector, hasDb }));
    },

    async openStore(name: string): Promise<BoardStore | null> {
      // Gate 1 — membership, not path math: `name` must be `===` one of
      // the CURRENT directory names, freshly read from disk.
      const infos = await listProfileInfos(root);
      const info = infos.find((p) => p.name === name);
      if (!info) return null;

      // Gate 2 — never create a DB file for a profile that doesn't have one.
      if (!info.hasDb) return null;

      const existing = stores.get(name);
      if (existing) return existing;

      // Gate 3 — only now open (and memoize) the real store.
      const store = new SqliteBoardStore(openJobsDb(info.dbPath));
      stores.set(name, store);
      return store;
    },

    async readConfigDoc(name: string, doc: ConfigDocKey): Promise<string | undefined> {
      const infos = await listProfileInfos(root);
      if (!infos.some((p) => p.name === name)) return undefined;

      const store = wireConfigStore(name, { root, liftMode: 'readonly' });
      try {
        return await store.readText(doc);
      } finally {
        store.close();
      }
    },

    async writeConfigDoc(
      name: string,
      doc: ConfigDocKey,
      rawText: string,
    ): Promise<void> {
      const infos = await listProfileInfos(root);
      if (!infos.some((p) => p.name === name)) {
        throw new Error(`unknown profile: ${name}`);
      }

      const store = wireConfigStore(name, { root, liftMode: 'readwrite' });
      try {
        await store.writeText(doc, rawText);
      } finally {
        store.close();
      }
    },

    async createProfile(name: string): Promise<void> {
      // Regex check FIRST — before any fs touch, per the port's own
      // traversal discipline (name never flows into a path until proven
      // safe).
      if (!PROFILE_NAME_RE.test(name)) {
        throw new Error(`invalid profile name: ${name}`);
      }

      const infos = await listProfileInfos(root);
      if (infos.some((p) => p.name === name)) {
        throw new Error(`profile already exists: ${name}`);
      }

      // seedProfileDocs itself mkdirs `profiles/<name>`, and each config
      // doc write opens a fresh short-lived `ConfigStore` whose own
      // `openJobsDb` mkdirs `profiles/<name>/data` on first write — no
      // separate mkdir call is needed here.
      await seedProfileDocs(name, {
        root,
        configStore: (n) => wireConfigStore(n, { root, liftMode: 'readwrite' }),
        mkdir: (p) => mkdir(p, { recursive: true }),
        write: () => {}, // silent — the route reports the outcome, not this seam
      });
    },

    async runDoctor(name: string): Promise<DoctorReport | null> {
      // Same membership gate as `openStore`/`readConfigDoc` — re-derived
      // against the CURRENT directory names, never path math. The actual
      // check-running (and its own short-lived `configStore` close) lives
      // in `board_doctor.ts` — split out purely for the file-size cap.
      const infos = await listProfileInfos(root);
      if (!infos.some((p) => p.name === name)) return null;
      return runBoardDoctor(name, root);
    },

    readDaemonStatus(): Promise<DaemonStatus> {
      return readBoardDaemonStatus({ root });
    },

    async openIntents(name: string): Promise<RunIntentStore | null> {
      // Same membership gate as `openStore` (gate 1) — re-derived against
      // the CURRENT directory names, never path math. Unlike `openStore`,
      // there is no `hasDb` gate: an intent is durable state a never-run
      // profile must still be able to record, so opening the store is
      // allowed to create-and-migrate the db as a side effect.
      const infos = await listProfileInfos(root);
      const info = infos.find((p) => p.name === name);
      if (!info) return null;

      const existing = intentStores.get(name);
      if (existing) return existing;

      const store = new SqliteRunIntentStore(info.dbPath);
      intentStores.set(name, store);
      return store;
    },

    async listSecrets(): Promise<SecretPresence> {
      const text = await readEnvText(root);
      return Object.fromEntries(
        SECRET_KEYS.map((key) => [key, hasEnvValue(text, key) ? 'present' : 'absent']),
      ) as SecretPresence;
    },

    async writeSecret(key: SecretKey, value: string): Promise<void> {
      const text = await readEnvText(root);
      const updated = upsertEnvLine(text, key, value);
      const envPath = path.join(root, '.env');
      // `mode` on `writeFile` only applies when the file is CREATED — an
      // already-existing `.env` (the common case: most calls are updates
      // to a file `setup` already created) keeps whatever permissions it
      // already had unless chmod'd explicitly, so every write chmods the
      // file to `0o600` afterward regardless of whether it already existed.
      await writeFile(envPath, updated, { mode: 0o600 });
      await chmodEnvFile(envPath, 0o600);
      // `.env` is loaded exactly once, at CLI startup (`main.ts`'s
      // `dotenv.config`) — the long-lived board process never re-reads
      // it. Without this, `GET /api/profiles/:name/doctor` (which reads
      // `process.env` via `ops/doctor/aggregate.ts`'s `resolveEnv`) keeps
      // reporting the token missing until the server restarts, even
      // though `GET /api/secrets` (which re-reads the file) already says
      // 'present' — process-visible so the two endpoints agree.
      process.env[key] = value;
    },

    // Guard order is the design (Task 8) — membership, protected, running
    // run, pending intent, handle release, delete. See the port's own doc
    // comment for the rationale.
    async removeProfile(name: string): Promise<RemoveProfileOutcome> {
      // Gate 1 — membership, not path math: re-derived against the
      // CURRENT directory names, same as every other traversal-sensitive
      // method above. This is what makes an attacker-supplied name safe
      // to use in a path below.
      const infos = await listProfileInfos(root);
      if (!infos.some((p) => p.name === name)) return { outcome: 'not_found' };

      // Gate 2 — protected fixture profile, no I/O. Imported from the CLI
      // command so the two can never disagree.
      if (PROTECTED_PROFILES.has(name)) return { outcome: 'protected' };

      // Gate 3 — a running run blocks; a crashed (stale-heartbeat) one
      // does not, so one wedged run can never make a profile permanently
      // undeletable.
      const store = await this.openStore(name);
      if (store) {
        const { rows } = store.listRuns({ limit: 1, offset: 0 });
        if (rows[0]?.status === 'running') {
          return { outcome: 'run_in_progress', runId: rows[0].id };
        }
      }

      // Gate 4 — a pending intent blocks; an expired one does not, so a
      // dead daemon can never strand the profile.
      const intents = await this.openIntents(name);
      if (intents) {
        const intent = intents.latest(new Date().toISOString());
        if (intent?.status === 'pending') {
          return { outcome: 'intent_pending', intentId: intent.id };
        }
      }

      // Gate 5 — release memoized handles before deleting anything: an
      // open sqlite handle makes the directory undeletable on Windows and
      // leaves a stale handle pointing at a deleted file everywhere else.
      const openBoardStore = stores.get(name);
      if (openBoardStore) {
        openBoardStore.close();
        stores.delete(name);
      }
      const openIntentStore = intentStores.get(name);
      if (openIntentStore) {
        openIntentStore.close();
        intentStores.delete(name);
      }

      // Gate 6 — delete. Never touches Notion or the network.
      await rm(path.join(root, 'profiles', name), { recursive: true, force: true });
      return { outcome: 'removed' };
    },

    close(): void {
      for (const store of stores.values()) store.close();
      stores.clear();
      for (const store of intentStores.values()) store.close();
      intentStores.clear();
    },
  };
}
