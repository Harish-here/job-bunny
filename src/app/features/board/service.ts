/**
 * The board's read/write service over one profile's `BoardStore` — the
 * thin layer `routes.ts` calls after resolving `:name` to a store. Owns
 * the missing-job -> HttpError(404) translation; `routes.ts` owns request
 * validation and the not-a-local-db-profile 404.
 */
import type {
  BoardJobDetail,
  BoardJobRow,
  BoardQuery,
  BoardStore,
  TrackingPatch,
  TrackingRow,
} from '../../../ports/board.ts';
import { HttpError } from '../../shared/index.ts';

export interface BoardService {
  list(query: BoardQuery): { rows: BoardJobRow[]; total: number };
  get(id: string): BoardJobDetail;
  patchTracking(id: string, patch: TrackingPatch, now: string): TrackingRow;
}

export function boardService(store: BoardStore): BoardService {
  return {
    list(query) {
      return store.listJobs(query);
    },
    get(id) {
      const job = store.getJob(id);
      if (!job) throw new HttpError(404, 'not_found', `no such job: ${id}`);
      return job;
    },
    patchTracking(id, patch, now) {
      const row = store.updateTracking(id, patch, now);
      if (!row) throw new HttpError(404, 'not_found', `no such job: ${id}`);
      return row;
    },
  };
}
