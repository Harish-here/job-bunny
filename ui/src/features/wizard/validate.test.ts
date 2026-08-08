import { describe, expect, it } from 'vitest';
import {
  type AboutValidationInput,
  type ExtrasValidationInput,
  type LaunchValidationInput,
  validateAbout,
  validateExtras,
  validateLaunch,
  validateName,
  validateUrlEntry,
} from './validate';
import type { SearchUrlEntry } from './wizard.types';

describe('validateName', () => {
  it('rejects a name with uppercase letters', () => {
    expect(validateName('MyProfile')).toEqual({
      name: 'Use lowercase letters, digits, underscores, and hyphens only.',
    });
  });

  it('accepts lowercase letters, digits, underscores, and hyphens', () => {
    expect(validateName('my-profile_1')).toEqual({});
  });
});

function baseAboutInput(
  overrides: Partial<AboutValidationInput> = {},
): AboutValidationInput {
  return { yoe: '', homeCity: 'Chennai', workTypes: ['remote'], ...overrides };
}

describe('validateAbout', () => {
  it('rejects a yoe outside 0-60', () => {
    expect(validateAbout(baseAboutInput({ yoe: '61' }))).toEqual({
      yoe: 'Enter years of experience as a whole number between 0 and 60.',
    });
  });

  it('accepts a blank yoe (optional field)', () => {
    expect(validateAbout(baseAboutInput({ yoe: '' }))).toEqual({});
  });

  it('rejects an empty home city', () => {
    expect(validateAbout(baseAboutInput({ homeCity: '' }))).toEqual({
      homeCity: 'Enter your home city.',
    });
  });

  it('accepts a non-empty home city', () => {
    expect(validateAbout(baseAboutInput({ homeCity: 'Bengaluru' }))).toEqual({});
  });

  it('rejects zero work types', () => {
    expect(validateAbout(baseAboutInput({ workTypes: [] }))).toEqual({
      workTypes: 'Pick at least one work type.',
    });
  });

  it('accepts at least one work type', () => {
    expect(validateAbout(baseAboutInput({ workTypes: ['hybrid'] }))).toEqual({});
  });
});

function urlEntry(overrides: Partial<SearchUrlEntry> = {}): SearchUrlEntry {
  return {
    label: 'Frontend Roles',
    url: 'https://www.linkedin.com/jobs/search/?keywords=frontend',
    ...overrides,
  };
}

describe('validateUrlEntry', () => {
  it('rejects a URL that does not start with https://', () => {
    expect(validateUrlEntry(urlEntry({ url: 'not a url' }))).toEqual({
      url: 'Enter a LinkedIn URL starting with https://',
    });
  });

  it('accepts an https:// linkedin.com URL', () => {
    expect(validateUrlEntry(urlEntry())).toEqual({});
  });

  it('rejects an https URL whose host is not linkedin.com', () => {
    expect(validateUrlEntry(urlEntry({ url: 'https://example.com/jobs' }))).toEqual({
      url: 'That URL is not a linkedin.com address.',
    });
  });

  it('accepts a linkedin.com subdomain host', () => {
    expect(
      validateUrlEntry(urlEntry({ url: 'https://www.linkedin.com/jobs/search' })),
    ).toEqual({});
  });

  it('rejects a blank label when a URL is given', () => {
    expect(validateUrlEntry(urlEntry({ label: '' }))).toEqual({
      label: 'Give this search a short label.',
    });
  });

  it('accepts a non-blank label', () => {
    expect(validateUrlEntry(urlEntry({ label: 'Staff Roles' }))).toEqual({});
  });
});

function baseExtrasInput(
  overrides: Partial<ExtrasValidationInput> = {},
): ExtrasValidationInput {
  return {
    notionDbId: '',
    notionToken: '',
    telegramToken: '',
    telegramChatId: '',
    notionMirror: false,
    ...overrides,
  };
}

describe('validateExtras', () => {
  it('rejects a notion database ID that is not 32 hex characters', () => {
    expect(validateExtras(baseExtrasInput({ notionDbId: 'short-id' }))).toEqual({
      notionDbId: 'A Notion database ID is 32 characters (letters and digits).',
    });
  });

  it('accepts a 32-character notion database ID with dashes', () => {
    expect(
      validateExtras(
        baseExtrasInput({ notionDbId: '12345678-1234-1234-1234-123456789012' }),
      ),
    ).toEqual({});
  });

  it('rejects a notion token that does not start with ntn_ or secret_', () => {
    expect(validateExtras(baseExtrasInput({ notionToken: 'abc123' }))).toEqual({
      notionToken: 'A Notion token starts with ntn_ or secret_.',
    });
  });

  it('accepts a notion token starting with secret_', () => {
    expect(validateExtras(baseExtrasInput({ notionToken: 'secret_abc123' }))).toEqual({});
  });

  it('rejects a malformed telegram bot token', () => {
    expect(validateExtras(baseExtrasInput({ telegramToken: '12345:short' }))).toEqual({
      telegramToken: 'A Telegram bot token looks like 123456789:AA… .',
    });
  });

  it('accepts a well-formed telegram bot token', () => {
    const token = `123456789:${'A'.repeat(35)}`;
    expect(validateExtras(baseExtrasInput({ telegramToken: token }))).toEqual({});
  });

  it('rejects a non-numeric telegram chat ID', () => {
    expect(validateExtras(baseExtrasInput({ telegramChatId: 'abc' }))).toEqual({
      telegramChatId: 'A Telegram chat ID is a whole number.',
    });
  });

  it('accepts a negative whole number telegram chat ID', () => {
    expect(validateExtras(baseExtrasInput({ telegramChatId: '-123456789' }))).toEqual({});
  });

  it('rejects the mirror switched on with a blank database ID', () => {
    expect(
      validateExtras(baseExtrasInput({ notionDbId: '', notionMirror: true })),
    ).toEqual({
      notionDbId: 'Enter a Notion database ID to enable the mirror.',
    });
  });

  it('accepts the mirror switched on with a valid database ID', () => {
    expect(
      validateExtras(baseExtrasInput({ notionDbId: '1'.repeat(32), notionMirror: true })),
    ).toEqual({});
  });

  it('accepts the mirror switched off with a blank database ID', () => {
    expect(
      validateExtras(baseExtrasInput({ notionDbId: '', notionMirror: false })),
    ).toEqual({});
  });
});

function baseLaunchInput(
  overrides: Partial<LaunchValidationInput> = {},
): LaunchValidationInput {
  return { preset: 'morning', times: [], ...overrides };
}

describe('validateLaunch', () => {
  it('rejects a time not matching HH:MM (24-hour)', () => {
    expect(
      validateLaunch(baseLaunchInput({ preset: 'custom', times: ['9:00'] })),
    ).toEqual({ times: 'Enter a time as HH:MM (24-hour).' });
  });

  it('accepts a well-formed HH:MM time', () => {
    expect(
      validateLaunch(baseLaunchInput({ preset: 'custom', times: ['09:00'] })),
    ).toEqual({});
  });

  it('rejects zero times when the preset is custom', () => {
    expect(validateLaunch(baseLaunchInput({ preset: 'custom', times: [] }))).toEqual({
      times: 'Add at least one run time.',
    });
  });

  it('accepts zero times when the preset is not custom', () => {
    expect(validateLaunch(baseLaunchInput({ preset: 'morning', times: [] }))).toEqual({});
  });
});
