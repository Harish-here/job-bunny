/**
 * launchd.ts (P8 Task 2) — `Scheduler` port implementation
 * (`ports/scheduler.ts`) wrapping `launchctl`, ported from v0's
 * `scripts/ops/schedule.js` install/reconcile loop. All `launchctl` calls
 * go through an INJECTED async command-runner and all filesystem access
 * through an INJECTED fs-deps object — tests use in-memory fakes for both,
 * never a real shell-out or a real `~/Library/LaunchAgents` write.
 *
 * `install(jobs)` is a full DECLARATIVE reconcile, mirroring v0: the caller
 * passes the complete desired job set every time (not a delta) — anything
 * currently on disk under `com.jobbunny.*.plist` that isn't in that set is
 * booted out and deleted. `remove(profile)` is built on top of this: it
 * reads the current schedule back via `list()`, drops the one profile, and
 * re-`install`s the remainder, so a time slot that becomes empty is pruned
 * by `install`'s own stale-plist logic — no separate code path needed.
 *
 * `list()` recovers `time` from each plist's `<HHMM>` label suffix and
 * recovers `profile`(s) by reading the plist's own `ProgramArguments`
 * command string back off disk (the task brief calls this out as
 * acceptable/simpler than parsing `launchctl list`/`launchctl print`
 * output, which carries no profile information at all).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScheduledJob, Scheduler } from '../../../ports/scheduler.ts';
import { type BuildPlistsOptions, buildPlists } from './plist.ts';

/** Repo root, derived from this file's own location (mirrors
 * `cdp-chrome/launcher.ts`'s `DEFAULT_USER_DATA_DIR`) — never `process.cwd()`,
 * so it's correct regardless of the caller's working directory. */
const DEFAULT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const LABEL_RE = /^com\.jobbunny\.(\d{4})\.plist$/;
/** v0 labeled its agents `com.jobbunny.run.<HHMM>`, pointing at the deleted
 * `scripts/ops/run_scheduled.sh` — install()'s reconcile prune must match
 * them too, or they keep firing M–F forever with nothing left to run.
 * `list()` still skips them (no `--profile` to recover from the plist). */
const LEGACY_LABEL_RE = /^com\.jobbunny\.run\.\d{4}\.plist$/;
const PROFILE_RE = /--profile (\S+) --headless/g;

/** Minimal shape of an async `launchctl` (or equivalent) command runner —
 * injected so no test ever shells out for real. Resolves with the exit
 * code rather than throwing on a non-zero exit; `LaunchdScheduler` treats a
 * *thrown* rejection from `run` the same as a non-zero exit for the calls
 * it tolerates (`bootout`, which fails harmlessly on a not-yet-loaded job). */
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

export interface LaunchdFsDeps {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  writeFileSync: (path: string, content: string) => void;
  readFileSync: (path: string) => string;
  readdirSync: (path: string) => string[];
  unlinkSync: (path: string) => void;
}

const defaultFs: LaunchdFsDeps = {
  existsSync,
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  writeFileSync: (path, content) => {
    writeFileSync(path, content, 'utf8');
  },
  readFileSync: (path) => readFileSync(path, 'utf8'),
  readdirSync,
  unlinkSync,
};

export interface LaunchdSchedulerDeps {
  /** Executes `launchctl` (or a stub, in tests). Required — there is no
   * real-launchctl default so a test can never accidentally shell out. */
  run: CommandRunner;
  fs?: LaunchdFsDeps;
  /** Repo root, `cd`'d into by every generated plist's command and used as
   * `WorkingDirectory`. Default: this package's real repo root. */
  root?: string;
  /** Home directory — `<home>/Library/LaunchAgents` and the log dirs.
   * Default: `os.homedir()`. */
  home?: string;
  /** `launchctl`'s `gui/<uid>` target. Default: `process.getuid()`. */
  uid?: number;
  /** Forwarded to `buildPlists` — see `plist.ts`'s `DEFAULT_RUN_CAP_MS` doc
   * comment for why the default is 4.5h, not v0's 30 minutes. */
  runCapMs?: number;
  /** Absolute node binary embedded in every plist's command (see
   * `BuildPlistsOptions.nodeBin`). Default: `process.execPath` — the Node
   * this install itself is running under, which `engines` pins to ≥ 24. */
  nodeBin?: string;
}

export class LaunchdScheduler implements Scheduler {
  readonly name = 'launchd';
  private readonly run: CommandRunner;
  private readonly fs: LaunchdFsDeps;
  private readonly root: string;
  private readonly home: string;
  private readonly uid: number;
  private readonly runCapMs: number | undefined;
  private readonly nodeBin: string;

  constructor(deps: LaunchdSchedulerDeps) {
    this.run = deps.run;
    this.fs = deps.fs ?? defaultFs;
    this.root = deps.root ?? DEFAULT_ROOT;
    this.home = deps.home ?? homedir();
    this.uid = deps.uid ?? process.getuid?.() ?? 0;
    this.runCapMs = deps.runCapMs;
    this.nodeBin = deps.nodeBin ?? process.execPath;
  }

  private launchAgentsDir(): string {
    return join(this.home, 'Library', 'LaunchAgents');
  }

  private plistPath(label: string): string {
    return join(this.launchAgentsDir(), `${label}.plist`);
  }

  private buildOpts(): BuildPlistsOptions {
    return {
      root: this.root,
      home: this.home,
      runCapMs: this.runCapMs,
      nodeBin: this.nodeBin,
    };
  }

  /** Best-effort unload — tolerates a job that was never loaded (v0's
   * "expected on first install, silently ignore" case) whether the runner
   * reports that as a non-zero exit or a thrown rejection. */
  private async bootout(label: string): Promise<void> {
    try {
      await this.run('launchctl', ['bootout', `gui/${this.uid}/${label}`]);
    } catch {
      // not loaded — expected and harmless.
    }
  }

  /** Lists every `com.jobbunny.*.plist` file currently on disk in
   * LaunchAgents, as `{ label, path }` pairs. */
  private listPlistFiles(): Array<{ label: string; path: string }> {
    const dir = this.launchAgentsDir();
    if (!this.fs.existsSync(dir)) return [];
    return this.fs
      .readdirSync(dir)
      .filter((file) => LABEL_RE.test(file) || LEGACY_LABEL_RE.test(file))
      .map((file) => ({ label: file.replace(/\.plist$/, ''), path: join(dir, file) }));
  }

  async install(jobs: ScheduledJob[]): Promise<void> {
    const desired = buildPlists(jobs, this.buildOpts());
    const desiredLabels = new Set(desired.map((p) => p.label));
    const dir = this.launchAgentsDir();
    this.fs.mkdirSync(dir, { recursive: true });

    // Fail loudly NOW if the command a plist would embed cannot resolve —
    // otherwise every scheduled fire exits 127 with no digest, a silent
    // daily failure. Skipped for an empty desired set so remove-to-empty
    // still prunes on a machine where the toolchain has moved.
    if (desired.length > 0) {
      const entry = join(this.root, 'src', 'cli', 'main.ts');
      if (!this.fs.existsSync(this.nodeBin)) {
        throw new Error(
          `launchd: node binary not found at ${this.nodeBin} — refusing to install plists whose command cannot resolve`,
        );
      }
      if (!this.fs.existsSync(entry)) {
        throw new Error(
          `launchd: CLI entry point not found at ${entry} — refusing to install plists whose command cannot resolve`,
        );
      }
    }

    for (const plist of desired) {
      const plistPath = this.plistPath(plist.label);
      this.fs.writeFileSync(plistPath, plist.xml);
      await this.bootout(plist.label);
      const result = await this.run('launchctl', [
        'bootstrap',
        `gui/${this.uid}`,
        plistPath,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `launchd: bootstrap failed for ${plist.label} (exit ${result.exitCode}): ${result.stdout}`,
        );
      }
    }

    // Prune stale plists — anything on disk not in the desired set.
    for (const { label, path } of this.listPlistFiles()) {
      if (desiredLabels.has(label)) continue;
      await this.bootout(label);
      this.fs.unlinkSync(path);
    }
  }

  async remove(profile: string): Promise<void> {
    const current = await this.list();
    const remaining = current.filter((job) => job.profile !== profile);
    await this.install(remaining);
  }

  async list(): Promise<ScheduledJob[]> {
    const jobs: ScheduledJob[] = [];
    for (const { label, path } of this.listPlistFiles()) {
      const match = LABEL_RE.exec(`${label}.plist`);
      if (!match) continue;
      const hhmm = match[1] as string;
      const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
      const content = this.fs.readFileSync(path);
      for (const m of content.matchAll(PROFILE_RE)) {
        jobs.push({ profile: m[1] as string, time });
      }
    }
    return jobs;
  }
}
