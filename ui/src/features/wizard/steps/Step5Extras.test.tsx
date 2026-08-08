import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wizardApi from '../wizard.api';
import type { WizardDraft } from '../wizard.types';
import { Step5Extras } from './Step5Extras';

vi.mock('../wizard.api', () => ({
  putSecret: vi.fn(),
  patchProfileConfig: vi.fn(),
}));

function baseDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    version: 1,
    profile: 'wiz-test',
    step: 5,
    personaId: null,
    about: {
      seniority: [],
      yoe: null,
      coreSkills: [],
      secondarySkills: [],
      domainExperience: [],
      workTypes: [],
      locations: [],
    },
    hunt: { urls: [] },
    extras: {
      notionDbId: '',
      notionMirror: false,
      notionTokenSaved: false,
      telegramChatId: '',
      telegramTokenSaved: false,
    },
    launch: { preset: 'morning', customTimes: [], weekdays: [1, 2, 3, 4, 5] },
    ...overrides,
  };
}

function renderStep(
  draft: WizardDraft,
  handlers: {
    onDraftChange?: (next: WizardDraft) => void;
    onSkip?: () => void;
  } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const onDraftChange = handlers.onDraftChange ?? vi.fn();
  const onSkip = handlers.onSkip ?? vi.fn();
  const registerSubmit = vi.fn();
  const utils = render(
    <Step5Extras
      draft={draft}
      onDraftChange={onDraftChange}
      registerSubmit={registerSubmit}
      onSkip={onSkip}
    />,
    { wrapper },
  );
  return { ...utils, onDraftChange, onSkip, registerSubmit };
}

/** `registerSubmit` is called from a `useEffect` and re-registers on every
 * field change (see Step5Extras.tsx). The handler current at call time is
 * always the LAST one registered. */
function latestSubmitHandler(registerSubmit: ReturnType<typeof vi.fn>) {
  const call = registerSubmit.mock.calls.at(-1);
  const handler = call?.[0] as (() => Promise<boolean>) | null | undefined;
  if (handler == null) throw new Error('no submit handler is currently registered');
  return handler;
}

afterEach(() => {
  vi.clearAllMocks();
});

const HEX32 = '1'.repeat(32);
const TELEGRAM_TOKEN = `123456789:${'A'.repeat(35)}`;

describe('Step5Extras', () => {
  it('registers a submit handler on mount and clears it on unmount', () => {
    const { registerSubmit, unmount } = renderStep(baseDraft());
    expect(registerSubmit).toHaveBeenCalledWith(expect.any(Function));
    unmount();
    expect(registerSubmit).toHaveBeenLastCalledWith(null);
  });

  it('an empty step resolves true with zero requests', async () => {
    const { registerSubmit } = renderStep(baseDraft());
    await expect(latestSubmitHandler(registerSubmit)()).resolves.toBe(true);
    expect(wizardApi.putSecret).not.toHaveBeenCalled();
    expect(wizardApi.patchProfileConfig).not.toHaveBeenCalled();
  });

  it('Skip fires its own callback with zero requests even when a field holds invalid input', async () => {
    const { onSkip } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Notion database ID'), 'not-hex');
    await userEvent.click(screen.getByTestId('wizard-skip'));
    expect(wizardApi.putSecret).not.toHaveBeenCalled();
    expect(wizardApi.patchProfileConfig).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalled();
  });

  it('a typed-then-abandoned field is persisted to the draft immediately, before any submit', async () => {
    const { onDraftChange } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Notion database ID'), HEX32);
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        extras: expect.objectContaining({ notionDbId: HEX32 }),
      }),
    );
    // The regression this change fixes: the draft updates on every
    // keystroke, not only after a successful save, so pressing Back before
    // submitting never loses what was typed.
    expect(wizardApi.putSecret).not.toHaveBeenCalled();
    expect(wizardApi.patchProfileConfig).not.toHaveBeenCalled();
  });

  it('a malformed Notion database id shows the exact message and resolves false', async () => {
    const { registerSubmit } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Notion database ID'), 'short-id');
    await expect(latestSubmitHandler(registerSubmit)()).resolves.toBe(false);
    expect(
      screen.getByText('A Notion database ID is 32 characters (letters and digits).'),
    ).toBeInTheDocument();
  });

  it('a malformed Notion token shows the exact message and resolves false', async () => {
    const { registerSubmit } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Notion token'), 'abc123');
    await expect(latestSubmitHandler(registerSubmit)()).resolves.toBe(false);
    expect(
      screen.getByText('A Notion token starts with ntn_ or secret_.'),
    ).toBeInTheDocument();
  });

  it('a malformed Telegram token shows the exact message', async () => {
    const { registerSubmit } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Telegram bot token'), '12345:short');
    await expect(latestSubmitHandler(registerSubmit)()).resolves.toBe(false);
    expect(
      screen.getByText('A Telegram bot token looks like 123456789:AA… .'),
    ).toBeInTheDocument();
  });

  it('a non-numeric chat id shows the exact message', async () => {
    const { registerSubmit } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Telegram chat ID'), 'abc');
    await expect(latestSubmitHandler(registerSubmit)()).resolves.toBe(false);
    expect(screen.getByText('A Telegram chat ID is a whole number.')).toBeInTheDocument();
  });

  it(
    'a valid Notion token and database id issues PUT NOTION_TOKEN then patches ' +
      'settings.notion.dbId and settings.notion.mirror',
    async () => {
      vi.mocked(wizardApi.putSecret).mockResolvedValue(undefined);
      vi.mocked(wizardApi.patchProfileConfig).mockImplementation(async (_p, mutate) => {
        const cfg: Record<string, unknown> = {};
        mutate(cfg);
        expect(cfg.settings).toEqual({ notion: { dbId: HEX32, mirror: false } });
      });
      const { registerSubmit, onDraftChange } = renderStep(baseDraft());
      await userEvent.type(screen.getByLabelText('Notion token'), 'secret_abc123');
      await userEvent.type(screen.getByLabelText('Notion database ID'), HEX32);
      await expect(latestSubmitHandler(registerSubmit)()).resolves.toBe(true);
      expect(wizardApi.putSecret).toHaveBeenCalledWith('NOTION_TOKEN', 'secret_abc123');
      expect(wizardApi.patchProfileConfig).toHaveBeenCalledTimes(1);
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          extras: expect.objectContaining({ notionDbId: HEX32, notionTokenSaved: true }),
        }),
      );
    },
  );

  it(
    'a valid Telegram token and chat id issues PUT TELEGRAM_BOT_TOKEN then patches ' +
      'settings.telegram.chatId as a number and appends telegram to notifiers',
    async () => {
      vi.mocked(wizardApi.putSecret).mockResolvedValue(undefined);
      vi.mocked(wizardApi.patchProfileConfig).mockImplementation(async (_p, mutate) => {
        const cfg: Record<string, unknown> = { notifiers: [] };
        mutate(cfg);
        expect(cfg.settings).toEqual({ telegram: { chatId: 987654321 } });
        expect(cfg.notifiers).toEqual(['telegram']);
      });
      const { registerSubmit, onDraftChange } = renderStep(baseDraft());
      await userEvent.type(screen.getByLabelText('Telegram bot token'), TELEGRAM_TOKEN);
      await userEvent.type(screen.getByLabelText('Telegram chat ID'), '987654321');
      await expect(latestSubmitHandler(registerSubmit)()).resolves.toBe(true);
      expect(wizardApi.putSecret).toHaveBeenCalledWith(
        'TELEGRAM_BOT_TOKEN',
        TELEGRAM_TOKEN,
      );
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          extras: expect.objectContaining({
            telegramChatId: '987654321',
            telegramTokenSaved: true,
          }),
        }),
      );
    },
  );

  it('telegram is not duplicated in notifiers when already present', async () => {
    vi.mocked(wizardApi.putSecret).mockResolvedValue(undefined);
    vi.mocked(wizardApi.patchProfileConfig).mockImplementation(async (_p, mutate) => {
      const cfg: Record<string, unknown> = { notifiers: ['telegram'] };
      mutate(cfg);
      expect(cfg.notifiers).toEqual(['telegram']);
    });
    const { registerSubmit } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Telegram bot token'), TELEGRAM_TOKEN);
    await userEvent.type(screen.getByLabelText('Telegram chat ID'), '111');
    await latestSubmitHandler(registerSubmit)();
    expect(wizardApi.patchProfileConfig).toHaveBeenCalledTimes(1);
  });

  it('after a successful save the Saved — not verified copy is shown', async () => {
    vi.mocked(wizardApi.putSecret).mockResolvedValue(undefined);
    vi.mocked(wizardApi.patchProfileConfig).mockResolvedValue(undefined);
    const { registerSubmit } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Notion token'), 'secret_abc123');
    await userEvent.type(screen.getByLabelText('Notion database ID'), HEX32);
    await latestSubmitHandler(registerSubmit)();
    expect((await screen.findAllByText(/Saved — not verified/)).length).toBeGreaterThan(
      0,
    );
  });

  it('a 500 on the secret PUT rejects with a message that never contains the submitted token', async () => {
    const token = 'secret_abc123-do-not-leak';
    vi.mocked(wizardApi.putSecret).mockRejectedValue(new Error('secrets write failed'));
    const { registerSubmit } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Notion token'), token);
    let caught: unknown;
    try {
      await latestSubmitHandler(registerSubmit)();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('secrets write failed');
    expect((caught as Error).message).not.toContain(token);
  });

  it('the draft written after a successful save contains no token string', async () => {
    vi.mocked(wizardApi.putSecret).mockResolvedValue(undefined);
    vi.mocked(wizardApi.patchProfileConfig).mockResolvedValue(undefined);
    const token = 'secret_should-never-be-in-the-draft';
    const { registerSubmit, onDraftChange } = renderStep(baseDraft());
    await userEvent.type(screen.getByLabelText('Notion token'), token);
    await userEvent.type(screen.getByLabelText('Notion database ID'), HEX32);
    await latestSubmitHandler(registerSubmit)();
    expect(onDraftChange).toHaveBeenCalled();
    const lastPatch = (onDraftChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(lastPatch)).not.toContain(token);
  });
});
