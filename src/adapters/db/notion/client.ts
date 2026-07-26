import { Client as NotionSdkClient } from '@notionhq/client';

/**
 * Thin wrapper over `@notionhq/client` (P7 Task 3). Owns the three things
 * every caller of the real SDK needs and none of them should reimplement:
 * auth resolution, a bounded retry/backoff on transient HTTP failures, and
 * an abortable deadline per call. `Connector` (Task 4) is the only intended
 * caller — this module knows nothing about jobs/pages/dedup, only "make
 * this Notion API call, retrying/timing-out as configured".
 *
 * Auth: `NOTION_TOKEN` (or an injected `token`) is read in the constructor,
 * never at module load — importing this file must never throw just because
 * some unrelated test transitively pulls it in without the env var set.
 * Constructing a real `NotionApi` without a token (and without an injected
 * `client` stub) throws immediately and loudly; that's a config problem,
 * not a per-call one.
 *
 * Retry: 3 attempts (configurable), exponential backoff between them,
 * fired only for HTTP 409/429/5xx (`@notionhq/client`'s `APIResponseError`
 * exposes `.status`; a bare object with a numeric `.status` — what the test
 * stub throws — is treated the same way, so this doesn't hard-depend on the
 * SDK's error classes). Any other error (4xx validation, auth, a thrown
 * value with no `.status`) is not retried and propagates on the first
 * attempt.
 *
 * Abort: every call composes the caller-supplied `signal` with this
 * instance's own `timeoutMs` deadline via `AbortSignal.any` (mirrors
 * `claude-cli/provider.ts`), and races the SDK call against it. The
 * underlying SDK request keeps running to completion either way (the SDK
 * itself doesn't take a `signal` argument) — abort here means "stop
 * waiting on it", not "cancel the HTTP request in flight".
 *
 * SoftError vs. plain: `createPage`/`updatePage`/`archivePage` wrap an
 * exhausted-retry failure in `SoftError` — one page write (or archive) is a
 * narrow casualty a batch sync/archive (Task 4) can record and skip past.
 * `queryDatabase` never wraps: a failed cache rebuild isn't a per-item
 * casualty, it's the whole read failing, so it always throws plainly and
 * should fail the stage loudly (Notion is the source of truth — spec
 * invariant). Auth/config errors (thrown by the constructor, or a
 * non-retryable SDK error) are always plain, from every method — no point in
 * "soft" when the whole session may be broken.
 *
 * `archivePage` (added alongside Task 4's `archiveStale`, which needed a way
 * to express Notion's own archive/trash flag — `createPage`/`updatePage`
 * only ever touch `properties`) sends `{ page_id, archived: true }` with no
 * `properties` at all; this is additive on `NotionSdkClientLike.pages.update`
 * (`properties` widened to optional, `archived` added) and doesn't change
 * `updatePage`'s existing behavior or signature.
 */

import { SoftError } from '../../../core/errors/soft_error.ts';

export interface NotionApiOptions {
  /** Overrides `process.env.NOTION_TOKEN` — mainly for tests. */
  token?: string;
  /** Injected SDK client — bypasses real auth/network entirely. This is
   * how client.test.ts exercises retry/abort/pagination without touching
   * the network: the stub implements this same narrow surface. */
  client?: NotionSdkClientLike;
  /** Total attempts per call, including the first. Default 3 (spec: "3-attempt backoff"). */
  maxAttempts?: number;
  /** Base delay for exponential backoff between attempts (doubles each retry). */
  baseDelayMs?: number;
  /** Per-attempt deadline, composed with the caller's signal via `AbortSignal.any`. */
  timeoutMs?: number;
}

/** The narrow slice of `@notionhq/client`'s `Client` this module actually
 * calls. A real `Client` instance satisfies this structurally; tests inject
 * a hand-written stub instead of the real SDK. */
export interface NotionSdkClientLike {
  databases: {
    query(args: {
      database_id: string;
      start_cursor?: string;
      page_size?: number;
    }): Promise<{ results: unknown[]; has_more: boolean; next_cursor: string | null }>;
  };
  pages: {
    create(args: {
      parent: { database_id: string };
      properties: Record<string, unknown>;
    }): Promise<{ id: string }>;
    // `properties` optional and `archived` added (P7 Task 4, additive/
    // backward-compatible) so `archivePage` can send `{ page_id, archived:
    // true }` alone — Notion's own trash (recoverable), never a hard
    // delete. `updatePage` is unaffected: it always supplies `properties`.
    update(args: {
      page_id: string;
      properties?: Record<string, unknown>;
      archived?: boolean;
    }): Promise<{ id: string }>;
  };
}

/** Minimal caller context this module needs — a subset of `RunContext`
 * (P3's `ports/context.ts`) so this file doesn't have to import the full
 * port just for a `signal`. */
export interface CallContext {
  signal: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 30_000;

export class NotionApi {
  private readonly client: NotionSdkClientLike;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;

  constructor(opts: NotionApiOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (opts.client) {
      this.client = opts.client;
      return;
    }
    const token = opts.token ?? process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error(
        'NOTION_TOKEN missing — set it in .env (see /setup) or pass { token }.',
      );
    }
    // The real SDK's `properties` parameter type is a large, exact union of
    // Notion's per-property-type request shapes (title/rich_text/select/…);
    // `NotionSdkClientLike` intentionally widens that to `Record<string,
    // unknown>` so this module doesn't have to import/mirror that whole
    // union just to describe "an object of Notion property values" — the
    // real shape is still enforced at the call site by Task 4, which builds
    // `properties` from `schema.ts`'s `PROPERTIES`/`OPTIONS`. That widening
    // is exactly what makes a real `Client` not structurally assignable
    // to `NotionSdkClientLike` under `strictFunctionTypes`; the cast below
    // is the deliberate escape hatch for it.
    this.client = new NotionSdkClient({ auth: token }) as unknown as NotionSdkClientLike;
  }

  /** Paginated `databases.query` — follows `has_more`/`next_cursor` until
   * exhausted and returns every result in one array. Whole-read failure
   * (retries exhausted on any page) throws plainly: Task 4's `rebuildCache`
   * must fail the stage loudly, not swallow a partial cache as complete. */
  async queryDatabase(databaseId: string, ctx: CallContext): Promise<unknown[]> {
    const results: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.withRetry(
        () =>
          this.client.databases.query({ database_id: databaseId, start_cursor: cursor }),
        ctx,
      );
      results.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return results;
  }

  /** Creates one page. On exhausted retries, throws `SoftError('notion.createPage', ...)`
   * so a batch sync can record this one casualty and keep going — unless the
   * failure isn't retryable at all (auth/validation/etc.), which propagates
   * plainly on the first attempt (see `withRetry`). */
  async createPage(
    databaseId: string,
    properties: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<{ id: string }> {
    try {
      return await this.withRetry(
        () =>
          this.client.pages.create({ parent: { database_id: databaseId }, properties }),
        ctx,
      );
    } catch (err) {
      throw wrapIfRetryExhausted('notion.createPage', 'create page', err);
    }
  }

  /** Updates one page's properties. Same SoftError-on-exhausted-retry
   * contract as `createPage`. */
  async updatePage(
    pageId: string,
    properties: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<{ id: string }> {
    try {
      return await this.withRetry(
        () => this.client.pages.update({ page_id: pageId, properties }),
        ctx,
      );
    } catch (err) {
      throw wrapIfRetryExhausted('notion.updatePage', 'update page', err);
    }
  }

  /** Archives one page — Notion's own trash (`archived: true`, recoverable
   * for 30 days from the live DB UI), never a hard delete (the public API
   * exposes no permanent-delete call). Same SoftError-on-exhausted-retry
   * contract as `createPage`/`updatePage`: one page's archive failure is a
   * batch-continuable casualty (Task 4's `archiveStale`), not a whole-run
   * failure. */
  async archivePage(pageId: string, ctx: CallContext): Promise<{ id: string }> {
    try {
      return await this.withRetry(
        () => this.client.pages.update({ page_id: pageId, archived: true }),
        ctx,
      );
    } catch (err) {
      throw wrapIfRetryExhausted('notion.archivePage', 'archive page', err);
    }
  }

  /** Runs `fn` up to `maxAttempts` times. Each attempt is raced against a
   * fresh deadline (`ctx.signal` combined with `timeoutMs`); a retryable
   * failure (409/429/5xx) sleeps an exponentially growing delay before the
   * next attempt, itself abortable by `ctx.signal`. An abort at any point,
   * or a non-retryable error, stops immediately — no further attempts. */
  private async withRetry<T>(fn: () => Promise<T>, ctx: CallContext): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const deadline = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
      // Checked before calling `fn` (not just raced after) so an
      // already-aborted signal never reaches the SDK at all — an argument
      // like `raceAbort(fn(), deadline)` would call `fn()` regardless of
      // this check, since argument evaluation happens before the call.
      if (deadline.aborted) throw toAbortError(deadline);
      try {
        return await raceAbort(fn(), deadline);
      } catch (err) {
        lastErr = err;
        if (ctx.signal.aborted) throw toAbortError(ctx.signal);
        if (!isRetryableError(err) || attempt >= this.maxAttempts) throw err;
        await sleep(this.baseDelayMs * 2 ** (attempt - 1), ctx.signal);
      }
    }
    // Unreachable (the loop always returns or throws), but keeps TS happy
    // and gives a sane error if maxAttempts is ever configured to 0.
    throw lastErr ?? new Error('notion: withRetry exhausted with no attempts made');
  }
}

/** Exhausted-retry failures on a single-item write become a `SoftError`
 * (batch-continuable); everything else (non-retryable errors, which
 * `withRetry` throws on the first attempt) is rethrown as-is so auth/config
 * problems stay loud. */
function wrapIfRetryExhausted(scope: string, action: string, err: unknown): unknown {
  if (isRetryableError(err)) {
    return new SoftError(
      scope,
      `notion: failed to ${action} after retries: ${errorMessage(err)}`,
      {
        cause: err,
      },
    );
  }
  return err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for HTTP 409 (conflict), 429 (rate-limited), and any 5xx — the
 * transient-failure set worth retrying. Reads `.status` off the thrown
 * value rather than checking `instanceof APIResponseError` so the same
 * logic works against both the real SDK's error class and the plain
 * `{ status }` objects client.test.ts's stub throws. */
function isRetryableError(err: unknown): boolean {
  const status = statusOf(err);
  return status !== undefined && (status === 409 || status === 429 || status >= 500);
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** Rejects as soon as `signal` aborts, whichever happens first — the SDK
 * call itself is not cancelled (the SDK takes no signal), only our wait on
 * it. Mirrors the intent of `claude-cli/provider.ts`'s abort race without
 * the child-process kill machinery (there's no process to kill here). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // We're not awaiting `promise`'s own outcome (the caller only sees the
    // abort rejection below) — attach a no-op handler so its eventual
    // settlement, if a rejection, never surfaces as an unhandledRejection.
    promise.catch(() => {});
    return Promise.reject(toAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function toAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error('notion: aborted', { cause: reason });
}

/** Abortable sleep for the backoff delay between retry attempts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(toAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
