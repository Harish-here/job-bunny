import type { SchedulePreset, SearchUrlEntry, WorkType } from './wizard.types';

const NAME_RE = /^[a-z0-9_-]{1,64}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TELEGRAM_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT_ID_RE = /^-?\d+$/;
const NOTION_DB_ID_RE = /^[0-9a-fA-F]{32}$/;

export function validateName(name: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!NAME_RE.test(name)) {
    errors.name = 'Use lowercase letters, digits, underscores, and hyphens only.';
  }
  return errors;
}

export interface AboutValidationInput {
  yoe: string;
  homeCity: string;
  workTypes: WorkType[];
}

export function validateAbout(input: AboutValidationInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const yoe = input.yoe.trim();
  if (yoe !== '' && (!/^\d+$/.test(yoe) || Number(yoe) > 60)) {
    errors.yoe = 'Enter years of experience as a whole number between 0 and 60.';
  }
  if (input.homeCity.trim() === '') {
    errors.homeCity = 'Enter your home city.';
  }
  if (input.workTypes.length === 0) {
    errors.workTypes = 'Pick at least one work type.';
  }
  return errors;
}

export function validateUrlEntry(entry: SearchUrlEntry): Record<string, string> {
  const errors: Record<string, string> = {};
  const url = entry.url.trim();
  if (url === '') return errors;

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed == null || parsed.protocol !== 'https:') {
    errors.url = 'Enter a LinkedIn URL starting with https://';
  } else if (
    parsed.hostname !== 'linkedin.com' &&
    !parsed.hostname.endsWith('.linkedin.com')
  ) {
    errors.url = 'That URL is not a linkedin.com address.';
  }
  if (entry.label.trim() === '') {
    errors.label = 'Give this search a short label.';
  }
  return errors;
}

export interface ExtrasValidationInput {
  notionDbId: string;
  notionToken: string;
  telegramToken: string;
  telegramChatId: string;
}

export function validateExtras(input: ExtrasValidationInput): Record<string, string> {
  const errors: Record<string, string> = {};

  const notionDbId = input.notionDbId.trim();
  if (notionDbId !== '' && !NOTION_DB_ID_RE.test(notionDbId.replace(/-/g, ''))) {
    errors.notionDbId = 'A Notion database ID is 32 characters (letters and digits).';
  }

  const notionToken = input.notionToken.trim();
  if (
    notionToken !== '' &&
    !notionToken.startsWith('ntn_') &&
    !notionToken.startsWith('secret_')
  ) {
    errors.notionToken = 'A Notion token starts with ntn_ or secret_.';
  }

  const telegramToken = input.telegramToken.trim();
  if (telegramToken !== '' && !TELEGRAM_TOKEN_RE.test(telegramToken)) {
    errors.telegramToken = 'A Telegram bot token looks like 123456789:AA… .';
  }

  const telegramChatId = input.telegramChatId.trim();
  if (telegramChatId !== '' && !TELEGRAM_CHAT_ID_RE.test(telegramChatId)) {
    errors.telegramChatId = 'A Telegram chat ID is a whole number.';
  }

  return errors;
}

export interface LaunchValidationInput {
  preset: SchedulePreset;
  times: string[];
}

export function validateLaunch(input: LaunchValidationInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const hasBadTime = input.times.some((time) => !TIME_RE.test(time));
  if (hasBadTime) {
    errors.times = 'Enter a time as HH:MM (24-hour).';
  } else if (input.preset === 'custom' && input.times.length === 0) {
    errors.times = 'Add at least one run time.';
  }
  return errors;
}
