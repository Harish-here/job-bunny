export type { BoardProfile } from '../../../ports/board.ts';
export type { ConfigDocKey } from '../../../ports/config_store.ts';
export type {
  ConfigGetResponse, // { text: string }
  CreateProfileResponse, // { profile: BoardProfile }
} from './routes.ts';
export { makeConfigRoutes } from './routes.ts';
export { saveSearchUrlsDoc } from './search_urls_save.ts';
