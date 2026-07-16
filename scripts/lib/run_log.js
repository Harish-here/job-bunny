// scripts/lib/run_log.js — tiny structured checkpoint logger. No dependencies. Mirrors every
// line to the console and, when a filePath is configured, appends it to a run log file too —
// an append failure degrades to console-only rather than ever throwing (logging must never be
// the thing that breaks a pipeline stage).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// PURE — one line of the log. Exact shape:
//   <iso-ts> [<tag>] <LEVEL?> <stage?> <k=v ...> <msg>
// LEVEL is omitted for "info" (the common case); present and upper-cased for warn/error.
// ctx entries render in insertion order as ` k=v`, skipping null/undefined values.
export function formatLine({ ts, tag, level = "info", stage = null, ctx = null, msg = "" }) {
  let line = `${ts} [${tag}]`;
  if (level !== "info") line += ` ${level.toUpperCase()}`;
  if (stage) line += ` ${stage}`;
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (v === null || v === undefined) continue;
      line += ` ${k}=${v}`;
    }
  }
  if (msg) line += ` ${msg}`;
  return line.trimEnd();
}

export function createRunLog({ tag = "extract", filePath = null, baseCtx = {}, onCheckpoint = null } = {}) {
  let dirEnsured = false;
  let warnedOnce = false;

  async function append(line) {
    if (!filePath) return;
    try {
      if (!dirEnsured) {
        await mkdir(dirname(filePath), { recursive: true });
        dirEnsured = true;
      }
      await appendFile(filePath, line + "\n");
    } catch (err) {
      if (!warnedOnce) {
        warnedOnce = true;
        console.warn(`[run_log] failed to append to ${filePath} — degrading to console-only: ${err.message}`);
      }
    }
  }

  async function emit(level, msg, ctx, stage = null) {
    const line = formatLine({
      ts: new Date().toISOString(),
      tag,
      level,
      stage,
      ctx: { ...baseCtx, ...ctx },
      msg,
    });
    const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(line);
    await append(line);
  }

  return {
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    async checkpoint(stage, ctx) {
      await emit("info", "CHECKPOINT", ctx, stage);
      if (onCheckpoint) {
        try {
          await onCheckpoint(stage, { ...baseCtx, ...ctx });
        } catch {
          // checkpoint hook failure must never break the calling stage
        }
      }
    },
    child(extraCtx) {
      return createRunLog({ tag, filePath, baseCtx: { ...baseCtx, ...extraCtx }, onCheckpoint });
    },
  };
}
