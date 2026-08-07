/**
 * commands/state.ts (P3-Task7) — `jobbunny state read|write` — a narrow CLI
 * surface over exactly the three structure hand-off documents
 * (`structure/table.json`, `structure/decisions.json`,
 * `structure/decisions.partial.json`) that `ctx.stateStore` now owns.
 *
 * Exists for `.claude/commands/structure.md`'s `/structure` slash command:
 * that skill is Claude Code itself running the structure stage's markdown
 * hand-off INLINE, without API access to the pipeline's own Node process —
 * it can shell out, but it cannot import `ctx.stateStore` directly. Wiring
 * `/structure` to actually call this surface is explicitly out of scope for
 * this change (advisor-supervised, protected path).
 *
 * NOT a general DB tool: `state write` only ever accepts `decisions`/
 * `decisions-partial` (the structure skill CONSUMES `table`, produced by the
 * `compress` stage — it never produces one). No `src/adapters/**` import
 * here — `wire` is injected (real default: `cli/wire/compose.ts`'s `wire`,
 * the sole adapter-import chokepoint).
 */
import { z } from 'zod';
import { TABLE_PATH } from '../../pipeline/stages/compress.ts';
import {
  DECISIONS_PARTIAL_PATH,
  DECISIONS_PATH,
} from '../../pipeline/stages/structure.ts';
import { wire as defaultWire, type WireResult } from '../wire/index.ts';

export interface StateCommandOptions {
  profile: string;
  action: 'read' | 'write';
  key: 'table' | 'decisions' | 'decisions-partial';
}

export interface StateDeps {
  wire: (profileName: string) => Promise<WireResult>;
  /** Injected so `state write`'s TTY guard stays testable without a real
   * terminal — defaults to the real `process.stdin.isTTY` check. */
  isStdinTty: () => boolean;
  readStdin: () => Promise<string>;
  /** Raw doc channel — NO injected newline (unlike every other command's
   * `write: (line: string) => void` / `console.log`). `state read` prints
   * the stored markdown table byte-for-byte; a caller piping the output
   * into a byte-identity diff would see a spurious trailing newline if this
   * went through the line-oriented convention instead. */
  writeRaw: (text: string) => void;
  /** Error/status messages — same shape as every other command's `write`,
   * just renamed and routed to stderr (models `main.ts`'s own `stderr`
   * dep) so it can never be confused with the raw doc channel above. */
  stderr: (line: string) => void;
}

function defaultDeps(): StateDeps {
  return {
    wire: defaultWire,
    isStdinTty: () => process.stdin.isTTY === true,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    writeRaw: (text: string) => {
      process.stdout.write(text);
    },
    stderr: (line: string) => console.error(line),
  };
}

/** Plain lookup, not a zod enum — `key` was already validated against this
 * exact set of literals by `args.ts`'s `buildOptions`; there is no untrusted
 * input left to re-validate here. */
const KEY_PATHS: Record<StateCommandOptions['key'], string> = {
  table: TABLE_PATH,
  decisions: DECISIONS_PATH,
  'decisions-partial': DECISIONS_PARTIAL_PATH,
};

export async function stateCommand(
  opts: StateCommandOptions,
  deps: Partial<StateDeps> = {},
): Promise<number> {
  const resolved: StateDeps = { ...defaultDeps(), ...deps };

  // Defense-in-depth: `buildOptions` already rejects `state write table`
  // before this command ever runs (reached only via a direct programmatic
  // caller that bypasses `buildOptions`) — fail before touching the DB at
  // all, i.e. no `wire()` call.
  if (opts.key === 'table' && opts.action === 'write') {
    resolved.stderr(
      'state write: "table" is read-only (produced by the compress stage) — ' +
        'only "decisions"/"decisions-partial" can be written',
    );
    return 1;
  }

  const path = KEY_PATHS[opts.key];
  const { ctx } = await resolved.wire(opts.profile);

  if (opts.action === 'read') {
    const doc = await ctx.stateStore.readDoc(path, z.string());
    if (doc === undefined) {
      resolved.stderr(`state read: no document found at "${path}"`);
      return 1;
    }
    resolved.writeRaw(doc);
    return 0;
  }

  if (resolved.isStdinTty()) {
    resolved.stderr('state write: expects the document on stdin (pipe it in)');
    return 1;
  }

  const content = await resolved.readStdin();
  await ctx.stateStore.writeDoc(path, content);
  return 0;
}
