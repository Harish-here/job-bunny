// Barrel for the Telegram notifier adapter (P8 Task 1).

export { type BotTokenCheckDeps, botTokenCheck } from './check.ts';
export { type DigestInput, formatDigest } from './format.ts';
export {
  TelegramNotifier,
  type TelegramNotifierSettings,
  TelegramNotifierSettingsSchema,
} from './telegram.ts';
