import { spawn } from 'node:child_process';
import type { LlmProvider } from '../../../ports/llm.ts';

/**
 * Claude Code CLI LLM provider (P6 Task 1). Shells out to the `claude`
 * binary already used interactively by this whole project: `claude -p
 * --output-format text`, prompt piped over stdin (never argv — keeps long
 * prompts off the process-list and out of shell-quoting territory). Kills
 * the child on abort (either the caller's `opts.signal` or this instance's
 * own `timeoutMs` deadline, combined via AbortSignal.any) and rejects with
 * stderr folded into the message on a non-zero exit. No retry/backoff here
 * — that's the structure stage's job (spec, P6 plan); this adapter only
 * owns the one child-process round trip.
 */

export interface ClaudeCliProviderOptions {
  /** Executable to spawn. Overridable so unit tests point it at a stub
   * script instead of the real `claude` binary. */
  command?: string;
  /** Per-call deadline, combined with the caller's `opts.signal`. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL escalation on abort, mirroring
   * `cdp-chrome/launcher.ts`'s killChrome. Overridable so tests don't wait
   * out the real default. */
  killGraceMs?: number;
}

export class ClaudeCliProvider implements LlmProvider {
  readonly name = 'claude-cli';
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;

  constructor({
    command = 'claude',
    timeoutMs = 300_000,
    killGraceMs = 5000,
  }: ClaudeCliProviderOptions = {}) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
  }

  async complete(prompt: string, opts: { signal: AbortSignal }): Promise<string> {
    const deadline = AbortSignal.any([opts.signal, AbortSignal.timeout(this.timeoutMs)]);
    return runClaudeCli(this.command, prompt, deadline, this.killGraceMs);
  }
}

/** Spawns `command -p --output-format text`, writes `prompt` to stdin,
 * resolves with stdout on a clean exit, rejects (stderr folded into the
 * message) on a non-zero exit, and kills the child if `signal` aborts
 * first — whichever happens first wins, exactly once. A child that ignores
 * SIGTERM is escalated to SIGKILL after `killGraceMs` (mirrors
 * `cdp-chrome/launcher.ts`'s killChrome) so `complete()` always settles. A
 * stdin write failure (e.g. EPIPE from a child that closed its read end
 * early) rejects rather than crashing the process on an unhandled stream
 * 'error'. */
function runClaudeCli(
  command: string,
  prompt: string,
  signal: AbortSignal,
  killGraceMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(toAbortError(signal));
      return;
    }

    const child = spawn(command, ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killChild = (killSignal: NodeJS.Signals) => {
      try {
        child.kill(killSignal);
      } catch {
        // already gone — the close/error handler below still settles.
      }
    };

    const onAbort = () => {
      if (settled) return;
      killChild('SIGTERM');
      // A child that ignores SIGTERM would otherwise leave 'close' unfired
      // and complete() hanging forever — escalate after a bounded grace
      // period so this always settles.
      killTimer = setTimeout(() => {
        if (settled) return;
        killChild('SIGKILL');
      }, killGraceMs);
      killTimer.unref?.();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Without this, a stdin write failure (e.g. EPIPE when the child closes
    // its read end before the write finishes flushing) is an unlistened
    // stream 'error' — fatal to the whole Node process, not just this call.
    child.stdin?.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild('SIGTERM');
      reject(
        new Error(`claude-cli: failed to write prompt to stdin: ${err.message}`, {
          cause: err,
        }),
      );
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal.aborted) {
        reject(toAbortError(signal));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude-cli exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function toAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error('claude-cli aborted', { cause: reason });
}
