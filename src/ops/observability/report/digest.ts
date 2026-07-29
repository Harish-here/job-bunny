/**
 * digest.ts (P8) — pure text-transform: builds the Telegram digest text
 * from a `RunResult` (`ops/observability/result.ts`). No I/O, no env — the
 * `run` CLI command builds the text here and hands it to `ctx.notify` as a
 * plain string; `TelegramNotifier` (adapters/notify/telegram/telegram.ts)
 * owns "how to send," this module owns "what the text looks like."
 *
 * Lives under `ops/` (not `adapters/notify/telegram/`, where it started)
 * because its real consumer is the `run` CLI command, which — per the
 * dependency-cruiser layering (`.dependency-cruiser.cjs`) — may import
 * `ops/**` but never `adapters/**`. Takes `RunResult` directly rather than
 * a shadow `DigestInput` type now that the formatter itself lives in
 * `ops/**` alongside `RunResult` (`ops/observability/run/result.ts`).
 *
 * Mirrors the v0 house style (`scripts/notify/telegram_format.js`): a single-line
 * `<statusIcon> Job Bunny — <profile>` banner (or `<statusIcon> Job Bunny` if
 * profile empty), the `────────────────` separator, and per-stage funnel lines.
 * Status icons: ✅ for passed, 🔴 for failed. Unlike v0 (which reformats
 * pre-composed markdown from an LLM), this builds plaintext directly from the
 * funnel data (`jobsIn`/`jobsOut`/`dropsByRule`) — no markdown-table parsing
 * needed since the input is already structured.
 *
 * Alerts (`NotifyEvent.kind === 'alert'`) are NOT digests: their text is
 * used verbatim by the caller, so this module owns only digest formatting.
 */
import type { RunResult } from '../run/index.ts';

const SEPARATOR = '────────────────';

function funnelLine(stage: RunResult['stages'][number]): string {
  const base = `  • ${stage.name}: ${stage.jobsIn} → ${stage.jobsOut}`;
  const drops = Object.entries(stage.dropsByRule);
  if (drops.length === 0) return base;
  const breakdown = drops.map(([rule, count]) => `${rule}: ${count}`).join(', ');
  return `${base} (dropped — ${breakdown})`;
}

export function formatDigest(result: RunResult, opts: { dryRun?: boolean } = {}): string {
  const passed = result.outcome === 'passed';
  const icon = passed ? '✅' : '🔴';
  const banner =
    `${icon} Job Bunny${result.profile ? ` — ${result.profile}` : ''}` +
    ` (${result.date} ${result.time})`;

  const lines = [banner, SEPARATOR];

  if (opts.dryRun) {
    lines.push('⚠️ DRY RUN — sync stage did not write to Notion');
  }

  if (!passed && result.failedStage) {
    lines.push(`Failed at stage: ${result.failedStage}`);
  }

  if (result.stages.length > 0) {
    lines.push('', 'Funnel:', ...result.stages.map(funnelLine));
  }

  return lines.join('\n');
}
