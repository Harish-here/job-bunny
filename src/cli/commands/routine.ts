/**
 * commands/routine.ts (P8) — the `routine <name>` CLI command: runs one
 * named `Routine` (routines/types.ts) from a profile's `wire()`-produced
 * `routines` array against the wired `PipelineCtx`, standalone — outside
 * any `/run`'s `pre-run`/`post-sync` scheduling. Only `cleanup` exists
 * today, but the lookup is by name against whatever `wire()` returns, not
 * hardcoded to it.
 *
 * An unknown routine name is a USER error, not a crash: it prints the
 * valid names and returns exit code 1 rather than throwing into `main`'s
 * catch.
 *
 * This command passes NOTHING dryRun-ish to the routine — `cleanup`'s
 * dry-run posture is owned entirely by the Notion connector
 * (`NotionConnectorSettings.dryRun`, defaults `true`, read from
 * `ctx.config.settings[connector]` inside the connector itself); flipping
 * it here would violate that ownership.
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import { wire as defaultWire, type WireResult } from '../wire.ts';

export interface RoutineCommandOptions {
  profile: string;
  routine: string;
}

export interface RoutineDeps {
  wire: (profileName: string) => Promise<WireResult>;
  write: (line: string) => void;
}

function defaultDeps(): RoutineDeps {
  return {
    wire: defaultWire,
    write: (line: string) => console.log(line),
  };
}

export async function routineCommand(
  opts: RoutineCommandOptions,
  deps: Partial<RoutineDeps> = {},
): Promise<number> {
  const resolved: RoutineDeps = { ...defaultDeps(), ...deps };
  const { ctx, routines } = await resolved.wire(opts.profile);

  const target = routines.find((r) => r.name === opts.routine);
  if (!target) {
    const names = routines.map((r) => r.name).join(', ');
    resolved.write(`unknown routine "${opts.routine}" — valid routines: ${names}`);
    return 1;
  }

  await target.run(ctx);

  resolved.write(`${target.name}: done`);

  return 0;
}
