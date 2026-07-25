import type { DoctorCheck, DoctorFinding } from '../../../ports/doctor.ts';

/**
 * botTokenCheck (P8) — DoctorCheck validating `TELEGRAM_BOT_TOKEN` against
 * Telegram's `getMe` endpoint. Mirrors `adapters/lanes/linkedin/inventory.ts`'s
 * factory-returns-`{ name, run() }` shape; `fetchFn`/`env` are injected so
 * this is fully offline-testable, and `run()` never throws — a doctor check
 * reports status, it never crashes the aggregation that collects it.
 *
 * Absent/empty token ⇒ red (nothing to validate). Present: a 200 with
 * `{ ok: true }` ⇒ ok; an auth failure (401/403, or a non-2xx body with
 * `{ ok: false }`) ⇒ red (the token itself is bad); any other failure
 * (network error, timeout, unexpected shape) ⇒ warn — this doctor check
 * can't tell "Telegram is down" from "my network is down", so it doesn't
 * fail the run over it.
 */
export interface BotTokenCheckDeps {
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export function botTokenCheck(deps: BotTokenCheckDeps = {}): DoctorCheck {
  const name = 'telegram-bot-token';
  const fetchFn = deps.fetchFn ?? fetch;
  const env = deps.env ?? process.env;
  return {
    name,
    async run(): Promise<DoctorFinding> {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return { check: name, status: 'red', detail: 'TELEGRAM_BOT_TOKEN not set' };
      }
      try {
        const res = await fetchFn(`https://api.telegram.org/bot${token}/getMe`);
        if (res.status === 401 || res.status === 403) {
          return {
            check: name,
            status: 'red',
            detail: 'bot token rejected by Telegram',
          };
        }
        const body = (await res.json().catch(() => undefined)) as
          | { ok?: boolean }
          | undefined;
        if (res.ok && body?.ok === true) {
          return { check: name, status: 'ok', detail: 'Telegram bot token is valid' };
        }
        if (body?.ok === false) {
          return {
            check: name,
            status: 'red',
            detail: 'bot token rejected by Telegram',
          };
        }
        return {
          check: name,
          status: 'warn',
          detail: 'could not reach Telegram to validate token',
        };
      } catch {
        return {
          check: name,
          status: 'warn',
          detail: 'could not reach Telegram to validate token',
        };
      }
    },
  };
}
