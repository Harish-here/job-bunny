/**
 * format.ts (P8 Task 1) — pure text-transform: builds the Telegram digest
 * text from a `RunResult`-shaped value (`ops/observability/result.ts`). No
 * I/O, no env — `telegram.ts` owns "how to send," this module owns "what
 * the text looks like."
 *
 * Mirrors the v0 house style (`scripts/notify/telegram_format.js`): the
 * `🐰 Job Bunny <profile>` banner, the `────────────────` separator, and
 * ✅/🔴 status icons. Unlike v0 (which reformats pre-composed markdown from
 * an LLM), this builds plaintext directly from the funnel data
 * (`jobsIn`/`jobsOut`/`dropsByRule`) — no markdown-table parsing needed
 * since the input is already structured.
 *
 * `DigestInput` deliberately mirrors `RunResult`'s shape rather than
 * importing it: `RunResult` lives under `src/ops/`, which transitively
 * pulls in the pipeline layer's `StagePayload`, and dependency-cruiser's
 * `adapters-only-ports-core` rule bars any `src/adapters/**` module from
 * depending on `src/ops/**` — including type-only imports (see
 * `.dependency-cruiser.cjs`, which explicitly tracks those edges). Every
 * real `RunResult` is structurally assignable to `DigestInput`, so the
 * pipeline/wire layer (which is allowed to import `ops`) can pass its
 * `RunResult` straight through with no cast.
 *
 * Alerts (`NotifyEvent.kind === 'alert'`) are NOT digests: their text is
 * used verbatim by the caller, so this module owns only digest formatting.
 */

export interface DigestInput {
  profile: string;
  date: string;
  outcome: 'passed' | 'failed';
  failedStage?: string;
  stages: Array<{
    name: string;
    jobsIn: number;
    jobsOut: number;
    dropsByRule: Record<string, number>;
  }>;
}

const SEPARATOR = '────────────────';

function funnelLine(stage: DigestInput['stages'][number]): string {
  const base = `  • ${stage.name}: ${stage.jobsIn} → ${stage.jobsOut}`;
  const drops = Object.entries(stage.dropsByRule);
  if (drops.length === 0) return base;
  const breakdown = drops.map(([rule, count]) => `${rule}: ${count}`).join(', ');
  return `${base} (dropped — ${breakdown})`;
}

export function formatDigest(result: DigestInput): string {
  const passed = result.outcome === 'passed';
  const icon = passed ? '✅' : '🔴';
  const banner = `🐰 Job Bunny — ${result.profile}`;
  const statusLine = `${icon} ${result.date} — ${result.outcome}`;

  const lines = [banner, SEPARATOR, statusLine];

  if (!passed && result.failedStage) {
    lines.push(`Failed at stage: ${result.failedStage}`);
  }

  if (result.stages.length > 0) {
    lines.push('', 'Funnel:', ...result.stages.map(funnelLine));
  }

  return lines.join('\n');
}
