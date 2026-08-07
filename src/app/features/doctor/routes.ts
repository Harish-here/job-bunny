/**
 * Doctor route (UI phase 1, Task 5) — a single, read-only diagnostics
 * endpoint over `BoardSource.runDoctor`, which composes and runs the SAME
 * checks the `jobbunny doctor` CLI command runs, degrading the same way
 * (`cli/wire/board.ts`'s `runDoctor`). Mirrors
 * `features/profiles/routes.ts`'s single-route shape: no `service.ts`
 * (two-pair rule keeps this slice at exactly one impl file plus
 * `index.ts`).
 */
import type { BoardSource } from '../../../ports/board.ts';
import type { DoctorReport } from '../../../ports/doctor.ts';
import type { BoardRequest, BoardResponse, RouteDef } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';

export type DoctorRouteResponse = Pick<DoctorReport, 'status' | 'findings'>;

function handler(source: BoardSource) {
  return async (req: BoardRequest): Promise<BoardResponse> => {
    const name = req.params.name;
    if (!name) throw new HttpError(400, 'bad_request', 'missing profile name');

    const report = await source.runDoctor(name);
    if (!report) throw new HttpError(404, 'no_such_profile', 'no such profile');

    const body: DoctorRouteResponse = {
      status: report.status,
      findings: report.findings,
    };
    return { status: 200, body };
  };
}

export function makeDoctorRoutes(source: BoardSource): RouteDef[] {
  return [
    { method: 'GET', path: '/api/profiles/:name/doctor', handler: handler(source) },
  ];
}
