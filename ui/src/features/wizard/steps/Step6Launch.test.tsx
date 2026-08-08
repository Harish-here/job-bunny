import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as draftStore from '../draftStore';
import * as wizardApi from '../wizard.api';
import type { WizardDraft } from '../wizard.types';
import { Step6Launch, type WizardStepProps } from './Step6Launch';

const chooseMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('../wizard.api', () => ({
  getDaemonStatus: vi.fn(),
  patchProfileConfig: vi.fn(),
  requestRunIntent: vi.fn(),
}));

vi.mock('../draftStore', () => ({
  clearDraft: vi.fn(),
}));

vi.mock('../../../lib/router', () => ({
  navigate: (route: unknown) => navigateMock(route),
}));

vi.mock('../../../lib/profile', () => ({
  useStoredProfile: () => [null, chooseMock] as const,
}));

function runningDaemon() {
  return {
    state: 'running' as const,
    pid: 123,
    startedAt: '2026-08-07T00:00:00.000Z',
    lastTickAt: '2026-08-07T00:00:30.000Z',
    inFlight: null,
    profiles: [],
  };
}

function stoppedDaemon() {
  return {
    state: 'stopped' as const,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    inFlight: null,
    profiles: [],
  };
}

/** A full `WizardDraft` fixture — `Step6Launch` reads only `draft.profile`
 * and `draft.launch`; the other slices are inert filler so the fixture
 * satisfies the frozen `WizardDraft` shape every step now receives whole. */
function baseDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    version: 1,
    profile: 'wiz-test',
    step: 6,
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
    wroteAbout: false,
    wroteHunt: false,
    ...overrides,
  };
}

function renderStep(overrides: Partial<WizardStepProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDraftChange = vi.fn();
  let handler: (() => Promise<boolean>) | null = null;
  const registerSubmit = vi.fn((h: (() => Promise<boolean>) | null) => {
    handler = h;
  });
  const props: WizardStepProps = {
    draft: baseDraft(),
    onDraftChange,
    registerSubmit,
    ...overrides,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const utils = render(<Step6Launch {...props} />, { wrapper });
  return {
    ...utils,
    onDraftChange,
    registerSubmit,
    /** Invokes the handler `Step6Launch` most recently gave `registerSubmit`
     * — this is exactly what `WizardPage`'s `wizard-next` button does. */
    submit: () => {
      if (!handler) throw new Error('Step6Launch never registered a submit handler.');
      return handler();
    },
    props,
  };
}

// `getByTestId`'s `selector` option is only honored by SelectorMatcherOptions
// queries (getByText, getByLabelText, …) — `queryAllByAttribute`, which backs
// testid queries in @testing-library/dom, does not accept `selector` at all
// and ignores it, so with several elements sharing one data-testid this must
// filter by the sibling data attribute itself instead.
async function clickPreset(preset: string) {
  const chip = screen
    .getAllByTestId('wizard-preset')
    .find((el) => el.getAttribute('data-preset') === preset);
  if (!chip) throw new Error(`No preset chip found for data-preset="${preset}"`);
  await userEvent.click(chip);
}

/** Captures the object `patchProfileConfig`'s `mutate` callback would apply
 * to `profile.json`, starting from an empty document (the seed shape a
 * freshly created wizard profile always has before this step writes). */
function capturePatch(): { schedule?: unknown } {
  const cfg: { schedule?: unknown } = {};
  vi.mocked(wizardApi.patchProfileConfig).mockImplementation(async (_p, mutate) => {
    mutate(cfg as Record<string, unknown>);
  });
  return cfg;
}

beforeEach(() => {
  vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue(runningDaemon());
  vi.mocked(wizardApi.patchProfileConfig).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Step6Launch — schedule presets', () => {
  it('the morning preset patches times ["09:00"] and enabled true', async () => {
    const cfg = capturePatch();
    const { submit } = renderStep();
    await clickPreset('morning');
    await expect(submit()).resolves.toBe(true);
    expect(cfg.schedule).toEqual({
      times: ['09:00'],
      enabled: true,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it('the morning-afternoon preset patches times ["09:00","14:00"] and enabled true', async () => {
    const cfg = capturePatch();
    const { submit } = renderStep();
    await clickPreset('morning-afternoon');
    await expect(submit()).resolves.toBe(true);
    expect(cfg.schedule).toEqual({
      times: ['09:00', '14:00'],
      enabled: true,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it('the custom preset patches de-duplicated, ascending-sorted user times', async () => {
    const cfg = capturePatch();
    const { submit } = renderStep();
    await clickPreset('custom');
    for (const time of ['14:00', '09:00', '09:00']) {
      await userEvent.type(screen.getByPlaceholderText('HH:MM'), time);
      await userEvent.click(screen.getByRole('button', { name: 'Add time' }));
    }
    await expect(submit()).resolves.toBe(true);
    expect(cfg.schedule).toEqual({
      times: ['09:00', '14:00'],
      enabled: true,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it('the manual preset patches times [] and enabled false', async () => {
    const cfg = capturePatch();
    const { submit } = renderStep();
    await clickPreset('manual');
    await expect(submit()).resolves.toBe(true);
    expect(cfg.schedule).toEqual({
      times: [],
      enabled: false,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it('the written schedule never carries a graceMinutes key', async () => {
    const cfg = capturePatch();
    const { submit } = renderStep();
    await clickPreset('morning');
    await submit();
    expect(Object.keys(cfg.schedule as object)).not.toContain('graceMinutes');
  });

  it('a custom preset with no times shows the "add a time" message and blocks submit', async () => {
    const { submit } = renderStep();
    await clickPreset('custom');
    await expect(submit()).resolves.toBe(false);
    expect(await screen.findByText('Add at least one run time.')).toBeInTheDocument();
    expect(wizardApi.patchProfileConfig).not.toHaveBeenCalled();
  });

  it('a malformed custom time shows the HH:MM message and blocks submit', async () => {
    const { submit } = renderStep();
    await clickPreset('custom');
    await userEvent.type(screen.getByPlaceholderText('HH:MM'), '9:00');
    await userEvent.click(screen.getByRole('button', { name: 'Add time' }));
    await expect(submit()).resolves.toBe(false);
    expect(
      await screen.findByText('Enter a time as HH:MM (24-hour).'),
    ).toBeInTheDocument();
    expect(wizardApi.patchProfileConfig).not.toHaveBeenCalled();
  });

  it('toggling a weekday reports the changed weekdays array via onDraftChange', async () => {
    const { onDraftChange } = renderStep();
    const sundayToggle = screen
      .getAllByTestId('wizard-weekday')
      .find((el) => el.getAttribute('data-weekday') === '0');
    if (!sundayToggle) throw new Error('No weekday toggle found for data-weekday="0"');
    await userEvent.click(sundayToggle);
    await waitFor(() => {
      expect(onDraftChange).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: expect.objectContaining({ weekdays: [0, 1, 2, 3, 4, 5] }),
        }),
      );
    });
  });
});

describe('Step6Launch — daemon status', () => {
  it('renders the daemon state with data-state from the mocked response', async () => {
    vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue(stoppedDaemon());
    renderStep();
    const el = await screen.findByTestId('wizard-daemon-state');
    expect(el).toHaveAttribute('data-state', 'stopped');
  });

  it('a stopped daemon shows the jobbunny serve start hint', async () => {
    vi.mocked(wizardApi.getDaemonStatus).mockResolvedValue(stoppedDaemon());
    renderStep();
    expect(await screen.findByText('jobbunny serve start')).toBeInTheDocument();
  });
});

describe('Step6Launch — run now', () => {
  it('a 201-shaped outcome renders data-state="queued"', async () => {
    vi.mocked(wizardApi.requestRunIntent).mockResolvedValue({
      kind: 'queued',
      deduped: false,
      intent: {
        id: 1,
        requestedAt: '2026-08-07T00:00:00.000Z',
        status: 'pending',
        claimedRunId: null,
      },
    });
    renderStep();
    await userEvent.click(screen.getByTestId('wizard-run-now'));
    const el = await screen.findByTestId('wizard-intent-state');
    expect(el).toHaveAttribute('data-state', 'queued');
  });

  it('a 200-shaped (deduped) outcome renders data-state="deduped"', async () => {
    vi.mocked(wizardApi.requestRunIntent).mockResolvedValue({
      kind: 'queued',
      deduped: true,
      intent: {
        id: 1,
        requestedAt: '2026-08-07T00:00:00.000Z',
        status: 'pending',
        claimedRunId: null,
      },
    });
    renderStep();
    await userEvent.click(screen.getByTestId('wizard-run-now'));
    const el = await screen.findByTestId('wizard-intent-state');
    expect(el).toHaveAttribute('data-state', 'deduped');
    expect(within(el).getByText('Already queued')).toBeInTheDocument();
  });

  it('a 409 outcome renders data-state="run_in_progress" including the run id', async () => {
    vi.mocked(wizardApi.requestRunIntent).mockResolvedValue({
      kind: 'run_in_progress',
      runId: 42,
    });
    renderStep();
    await userEvent.click(screen.getByTestId('wizard-run-now'));
    const el = await screen.findByTestId('wizard-intent-state');
    expect(el).toHaveAttribute('data-state', 'run_in_progress');
    expect(within(el).getByText(/42/)).toBeInTheDocument();
  });

  it('a 500 outcome renders data-state="error" with the server message verbatim', async () => {
    vi.mocked(wizardApi.requestRunIntent).mockResolvedValue({
      kind: 'error',
      message: 'daemon store unavailable',
    });
    renderStep();
    await userEvent.click(screen.getByTestId('wizard-run-now'));
    const el = await screen.findByTestId('wizard-intent-state');
    expect(el).toHaveAttribute('data-state', 'error');
    expect(within(el).getByText('daemon store unavailable')).toBeInTheDocument();
  });

  it('Run now calls requestRunIntent immediately, independent of submit', async () => {
    vi.mocked(wizardApi.requestRunIntent).mockResolvedValue({
      kind: 'queued',
      deduped: false,
      intent: {
        id: 1,
        requestedAt: '2026-08-07T00:00:00.000Z',
        status: 'pending',
        claimedRunId: null,
      },
    });
    renderStep();
    await userEvent.click(screen.getByTestId('wizard-run-now'));
    await waitFor(() => expect(wizardApi.requestRunIntent).toHaveBeenCalledTimes(1));
    expect(wizardApi.patchProfileConfig).not.toHaveBeenCalled();
  });

  it('submit never calls requestRunIntent, even after Run now was already pressed', async () => {
    const cfg = capturePatch();
    vi.mocked(wizardApi.requestRunIntent).mockResolvedValue({
      kind: 'queued',
      deduped: false,
      intent: {
        id: 1,
        requestedAt: '2026-08-07T00:00:00.000Z',
        status: 'pending',
        claimedRunId: null,
      },
    });
    const { submit } = renderStep();
    await userEvent.click(screen.getByTestId('wizard-run-now'));
    await waitFor(() => expect(wizardApi.requestRunIntent).toHaveBeenCalledTimes(1));
    await submit();
    expect(cfg.schedule).toBeDefined();
    expect(wizardApi.requestRunIntent).toHaveBeenCalledTimes(1);
  });
});

describe('Step6Launch — finishing the wizard', () => {
  it('submit patches the schedule, then clears both localStorage keys, then navigates to runs', async () => {
    const order: string[] = [];
    vi.mocked(wizardApi.patchProfileConfig).mockImplementation(async () => {
      order.push('patch');
    });
    vi.mocked(draftStore.clearDraft).mockImplementation(() => {
      order.push('clear');
    });
    const { submit } = renderStep({ draft: baseDraft({ profile: 'wiz-abc12345' }) });
    await expect(submit()).resolves.toBe(true);
    expect(navigateMock).toHaveBeenCalledWith({ name: 'runs' });
    expect(draftStore.clearDraft).toHaveBeenCalledWith('wiz-abc12345');
    expect(chooseMock).toHaveBeenCalledWith('wiz-abc12345');
    expect(order).toEqual(['patch', 'clear']);
  });

  it('a 422 on the schedule patch rejects, does not clear the draft, and does not navigate', async () => {
    vi.mocked(wizardApi.patchProfileConfig).mockRejectedValue(
      new Error('profile.json is invalid: expected object'),
    );
    const { submit } = renderStep();
    await expect(submit()).rejects.toThrow('profile.json is invalid: expected object');
    expect(draftStore.clearDraft).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('registers null with registerSubmit on unmount', () => {
    const { registerSubmit, unmount } = renderStep();
    registerSubmit.mockClear();
    unmount();
    expect(registerSubmit).toHaveBeenCalledWith(null);
  });
});
