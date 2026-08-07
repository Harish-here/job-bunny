// Barrel for the sqlite DB adapter (local-DB spec §4). The pipeline-side
// Connector surface, plus the app layer's BoardStore surface (PR 4).

export { SqliteBoardStore } from './board/index.ts';
export { type SqliteDbCheckDeps, sqliteDbCheck } from './check.ts';
export { SqliteCheckpointStore } from './checkpoints/index.ts';
export { SqliteConfigStore } from './config/index.ts';
export {
  isStale,
  SqliteConnector,
  type SqliteConnectorSettings,
  SqliteConnectorSettingsSchema,
} from './connector.ts';
export { RUN_HEARTBEAT_STALE_MS, SqliteRunStore } from './runs/index.ts';
export { SqliteStateStore } from './state/index.ts';
export { LATEST_SCHEMA_VERSION, openJobsDb, SqliteStore } from './store/index.ts';
