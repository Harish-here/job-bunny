// Barrel for the sqlite DB adapter (local-DB spec §4). The pipeline-side
// Connector surface; the BoardStore surface arrives with the app layer (PR 4).
export { type SqliteDbCheckDeps, sqliteDbCheck } from './check.ts';
export {
  isStale,
  SqliteConnector,
  type SqliteConnectorSettings,
  SqliteConnectorSettingsSchema,
} from './connector.ts';
export { LATEST_SCHEMA_VERSION, openJobsDb, SqliteStore } from './store/index.ts';
