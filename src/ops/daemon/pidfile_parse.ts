/**
 * ops/daemon/pidfile_parse.ts — `parsePidfile`'s own shape-check helpers,
 * split out of `./pidfile.ts` purely to keep that file under the file-size
 * cap (a non-behavioral split, same precedent as `./deps.ts` being split
 * out of `./daemon.ts` for the identical reason — see that file's own doc
 * comment). Every helper here follows the same posture: a value that
 * doesn't match its expected shape is DROPPED, never trusted — malformed
 * JSON (a hand-edited pidfile, a partial write, a future build's added
 * field this build doesn't know about) degrades to "absent," not a thrown
 * parse error.
 */
import type {
  DaemonDegradedEntry,
  DaemonInFlight,
  DeferredNotifyAttempt,
  SlotGateDecline,
} from './pidfile.ts';

/** Shape-checks a parsed `inFlight` value: either absent, or the full
 * `DaemonInFlight` object (`pid`/`profile`/`startedAt`) — never the old
 * bare-number form. A partially-shaped object is treated the same as
 * absent (malformed ⇒ safe to drop, not safe to trust). */
export function parseInFlight(value: unknown): DaemonInFlight | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DaemonInFlight>;
  if (
    typeof candidate.pid === 'number' &&
    typeof candidate.profile === 'string' &&
    typeof candidate.startedAt === 'string'
  ) {
    return {
      pid: candidate.pid,
      profile: candidate.profile,
      startedAt: candidate.startedAt,
    };
  }
  return undefined;
}

/** Shape-checks a single `degraded` entry: mirrors `parseInFlight` — every
 * field must match its expected type or the entry is dropped, not trusted. */
function parseDegradedEntry(value: unknown): DaemonDegradedEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DaemonDegradedEntry>;
  if (
    typeof candidate.profile === 'string' &&
    typeof candidate.schemaVersion === 'number' &&
    typeof candidate.buildVersion === 'number' &&
    typeof candidate.detectedAt === 'string'
  ) {
    return {
      profile: candidate.profile,
      schemaVersion: candidate.schemaVersion,
      buildVersion: candidate.buildVersion,
      detectedAt: candidate.detectedAt,
    };
  }
  return undefined;
}

/** A single malformed entry never rejects the whole array — same posture
 * as `parseInFlight`'s "malformed ⇒ drop, not trust." A non-array value
 * (or an absent one) is treated as an empty list, not an error. */
export function parseDegraded(value: unknown): DaemonDegradedEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseDegradedEntry(entry))
    .filter((entry): entry is DaemonDegradedEntry => entry !== undefined);
}

/** Shared parser for the nullable-ISO-timestamp latch/throttle fields
 * (`schemaDriftNotifiedAt`, `schemaDriftNoNotifierWarnedAt`,
 * `schemaDriftNotifyFailedAt`) — identical shape, identical
 * "malformed/absent ⇒ null" fallback. */
export function parseNullableTimestamp(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Shape-checks the `lastGateDecline` value: mirrors `parseDegradedEntry`'s
 * field-for-field checking, with `reasonCode` narrowed to exactly the two
 * literals this field's own (narrower-than-`DeferredSlotRow`) union allows —
 * a `'daemon-unavailable'` reasonCode is valid there but never here, since
 * that case means the daemon wasn't even running to gate anything. */
export function parseLastGateDecline(
  value: unknown,
):
  | { reasonCode: 'host-asleep' | 'network-unreachable'; reason: string; at: string }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<{
    reasonCode: unknown;
    reason: unknown;
    at: unknown;
  }>;
  if (
    typeof candidate.reasonCode === 'string' &&
    (candidate.reasonCode === 'host-asleep' ||
      candidate.reasonCode === 'network-unreachable') &&
    typeof candidate.reason === 'string' &&
    typeof candidate.at === 'string'
  ) {
    return {
      reasonCode: candidate.reasonCode,
      reason: candidate.reason,
      at: candidate.at,
    };
  }
  return undefined;
}

/** Shape-checks a single `slotGateDeclines` entry (bug 1, D9 — see
 * `deferred_sweep.ts`'s attribution loop): every field required, `reasonCode`
 * narrowed exactly like `parseLastGateDecline`'s own two-value union. */
function parseSlotGateDecline(value: unknown): SlotGateDecline | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<{
    profile: unknown;
    date: unknown;
    slot: unknown;
    reasonCode: unknown;
    reason: unknown;
    at: unknown;
  }>;
  if (
    typeof candidate.profile === 'string' &&
    typeof candidate.date === 'string' &&
    typeof candidate.slot === 'string' &&
    typeof candidate.reasonCode === 'string' &&
    (candidate.reasonCode === 'host-asleep' ||
      candidate.reasonCode === 'network-unreachable') &&
    typeof candidate.reason === 'string' &&
    typeof candidate.at === 'string'
  ) {
    return {
      profile: candidate.profile,
      date: candidate.date,
      slot: candidate.slot,
      reasonCode: candidate.reasonCode,
      reason: candidate.reason,
      at: candidate.at,
    };
  }
  return undefined;
}

/** Same "one malformed entry never rejects the whole array" posture as
 * `parseDegraded`. */
export function parseSlotGateDeclines(value: unknown): SlotGateDecline[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseSlotGateDecline(entry))
    .filter((entry): entry is SlotGateDecline => entry !== undefined);
}

/** Shape-checks a single `deferredNotifyAttempts` entry (bug 2/6 — see
 * `deferred_sweep.ts`'s notify-retry throttle). */
function parseDeferredNotifyAttempt(value: unknown): DeferredNotifyAttempt | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DeferredNotifyAttempt>;
  if (
    typeof candidate.profile === 'string' &&
    typeof candidate.date === 'string' &&
    typeof candidate.at === 'string'
  ) {
    return { profile: candidate.profile, date: candidate.date, at: candidate.at };
  }
  return undefined;
}

export function parseDeferredNotifyAttempts(value: unknown): DeferredNotifyAttempt[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseDeferredNotifyAttempt(entry))
    .filter((entry): entry is DeferredNotifyAttempt => entry !== undefined);
}
