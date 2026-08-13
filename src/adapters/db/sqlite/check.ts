/**
 * sqliteDbCheck — DoctorCheck for the local jobbunny.db. Read-only by
 * construction (readOnly open): doctor must never create or migrate the
 * file — that's openJobsDb's job on the first real run, which is why a
 * missing file is `ok`, not a warning. Mirrors the factory-returns-
 * `{ name, run() }` shape of adapters/db/notion/check.ts; run() never throws.
 */
import { existsSync } from 'node:fs';
import type { DoctorCheck, DoctorFinding } from '../../../ports/doctor.ts';
import { LATEST_SCHEMA_VERSION, readSchemaVersionReadonly } from './store/index.ts';

export interface SqliteDbCheckDeps {
  path: string;
}

export function sqliteDbCheck(deps: SqliteDbCheckDeps): DoctorCheck {
  const name = 'sqlite-db-openable';
  return {
    name,
    async run(): Promise<DoctorFinding> {
      if (!existsSync(deps.path)) {
        return {
          check: name,
          status: 'ok',
          detail: `no database yet at ${deps.path} — created on first run`,
        };
      }
      const version = readSchemaVersionReadonly(deps.path);
      if (version === undefined) {
        return {
          check: name,
          status: 'red',
          detail: `database not openable at ${deps.path}`,
        };
      }
      if (version > LATEST_SCHEMA_VERSION) {
        return {
          check: name,
          status: 'red',
          detail: `database schema v${version} is newer than this build supports (v${LATEST_SCHEMA_VERSION})`,
        };
      }
      return {
        check: name,
        status: 'ok',
        detail: `database openable (schema v${version})`,
      };
    },
  };
}
