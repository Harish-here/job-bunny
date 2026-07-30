/**
 * telegram.ts (P8 Task 1) — `Notifier` port implementation over Telegram's
 * Bot API `sendMessage`, using global `fetch` (no dependency). Settings
 * (`{ chatId }`) are validated by a zod schema AT CONSTRUCTION, mirroring
 * `NotionConnector` (`adapters/db/notion/connector.ts`): a bad/missing
 * `chatId` fails loudly and immediately at wiring time, not on the first
 * send. The bot token is a SECRET, never carried in `profile.json`/settings
 * — it comes from `process.env.TELEGRAM_BOT_TOKEN` only, read lazily at
 * `send()` time so a notifier can be constructed (e.g. for doctor checks)
 * before the env is guaranteed to be loaded.
 *
 * `NotifyEvent` already carries the final composed `text` (digest or
 * alert) — this class only transmits it; `ops/observability/report/digest.ts`
 * owns building digest text (the `run` CLI command formats it there,
 * outside the adapter layer).
 */
import { z } from 'zod';
import type { Notifier, NotifyEvent } from '../../../ports/notifier.ts';

export const TelegramNotifierSettingsSchema = z.object({
  chatId: z.number(),
});

export type TelegramNotifierSettings = z.infer<typeof TelegramNotifierSettingsSchema>;

/** Bound on the `sendMessage` HTTP call so a hung notifier (dead DNS, a
 * stalled TCP connection, Telegram itself wedged) can never stall the
 * whole process — `run.ts` awaits the digest send AFTER the pipeline has
 * already finished, so an unbounded fetch here would hang the CLI exit. */
const SEND_TIMEOUT_MS = 10_000;

export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  private readonly settings: TelegramNotifierSettings;

  constructor(settings: unknown) {
    this.settings = TelegramNotifierSettingsSchema.parse(settings);
  }

  async send(event: NotifyEvent): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error('telegram: TELEGRAM_BOT_TOKEN is not set');
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.settings.chatId, text: event.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`telegram: sendMessage failed with status ${response.status}`);
    }
  }
}
