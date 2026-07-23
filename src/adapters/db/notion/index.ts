// Barrel for the Notion DB adapter (P7). Task 3 exports the schema pin and
// the API client; Task 4 adds the cache/sync/archive functions and the
// `Connector` implementation.

export { archiveStale } from './archive.ts';
export { rebuildCache } from './cache.ts';
export {
  type CallContext,
  NotionApi,
  type NotionApiOptions,
  type NotionSdkClientLike,
} from './client.ts';
export {
  NotionConnector,
  type NotionConnectorSettings,
  NotionConnectorSettingsSchema,
} from './connector.ts';
export {
  AUTOMATED_FIELDS,
  EXCITEMENT_OPTIONS,
  type NotionPropertyType,
  OPTIONS,
  PROPERTIES,
  type PropertyDescriptor,
  SENIORITY_OPTIONS,
  STATUS_OPTIONS,
  TIMEZONE_OPTIONS,
  WORK_TYPE_OPTIONS,
} from './schema.ts';
export { buildAutomatedProperties, syncJobs } from './sync.ts';
