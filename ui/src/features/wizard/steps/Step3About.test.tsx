import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../../settings/config.api';
import { deriveFilter } from '../deriveFilter';
import { serializeFilter } from '../serialize';
import * as wizardApi from '../wizard.api';
import type { AboutAnswers, Persona, PersonaCatalog, WizardDraft } from '../wizard.types';
import { Step3About } from './Step3About';

vi.mock('../../settings/config.api', () => ({ getConfigDoc: vi.fn() }));
vi.mock('../wizard.api', () => ({ getPersonas: vi.fn(), writeConfigDocText: vi.fn() }));

const FRONTEND_PERSONA: Persona = {
  id: 'frontend',
  label: 'Frontend',
  blurb: 'Frontend engineering roles.',
  coreSkills: ['React', 'TypeScript'],
  secondarySkills: ['Vue.js'],
  seniorityOptions: ['Staff', 'Lead', 'Principal'],
  title: {
    domain: { match: ['Frontend', 'UI'], reject: [] },
    function: { match: ['Engineer'], reject: [] },
  },
};

const CATALOG: PersonaCatalog = { version: 1, personas: [FRONTEND_PERSONA] };

function baseAbout(overrides: Partial<AboutAnswers> = {}): AboutAnswers {
  return {
    seniority: [],
    yoe: null,
    coreSkills: [],
    secondarySkills: [],
    domainExperience: [],
    workTypes: [],
    locations: [],
    ...overrides,
  };
}

function baseDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    version: 1,
    profile: 'rajni',
    step: 3,
    personaId: 'frontend',
    about: baseAbout(),
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

function stubGuardPasses() {
  vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '' });
}

function renderStep(
  overrides: { draft?: WizardDraft; onDraftChange?: (next: WizardDraft) => void } = {},
) {
  const onDraftChange = overrides.onDraftChange ?? vi.fn();
  let submitHandler: (() => Promise<boolean>) | null = null;
  const registerSubmit = vi.fn((handler: (() => Promise<boolean>) | null) => {
    submitHandler = handler;
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { unmount } = render(
    <Step3About
      draft={overrides.draft ?? baseDraft()}
      onDraftChange={onDraftChange}
      registerSubmit={registerSubmit}
    />,
    { wrapper },
  );
  return { onDraftChange, registerSubmit, getHandler: () => submitHandler, unmount };
}

async function fillValidRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Home city'), 'Chennai');
  await user.click(screen.getByRole('checkbox', { name: 'Remote' }));
}

beforeEach(() => {
  vi.mocked(wizardApi.getPersonas).mockResolvedValue(CATALOG);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Step3About', () => {
  it('persona pre-fill populates the skill chips', async () => {
    renderStep();
    expect(await screen.findByText('React')).toBeInTheDocument();
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Vue.js')).toBeInTheDocument();
  });

  it('removing a chip updates the derived JSON', async () => {
    const user = userEvent.setup();
    renderStep();

    await user.click(screen.getByRole('button', { name: 'Staff' }));
    await user.click(screen.getByRole('button', { name: 'Lead' }));
    await user.click(screen.getByRole('button', { name: 'Show derived filter rules' }));

    const before = JSON.parse(
      screen.getByTestId('wizard-derived-json').textContent ?? '{}',
    );
    expect(before.title.seniority.match).toEqual(['staff', 'lead']);

    await user.click(screen.getByRole('button', { name: 'Staff' }));

    const after = JSON.parse(
      screen.getByTestId('wizard-derived-json').textContent ?? '{}',
    );
    expect(after.title.seniority.match).toEqual(['lead']);
  });

  it(
    'an invalid yoe renders the exact message on that field and the registered ' +
      'submit handler resolves false without issuing any request',
    async () => {
      const user = userEvent.setup();
      const { getHandler } = renderStep();

      await user.type(screen.getByLabelText('Years of experience'), '61');
      await fillValidRequiredFields(user);
      const result = await getHandler()?.();

      expect(result).toBe(false);
      expect(
        screen.getByText('Enter years of experience as a whole number between 0 and 60.'),
      ).toBeInTheDocument();
      expect(wizardApi.writeConfigDocText).not.toHaveBeenCalled();
      expect(configApi.getConfigDoc).not.toHaveBeenCalled();
    },
  );

  it('a missing home city blocks the registered submit handler', async () => {
    const user = userEvent.setup();
    const { getHandler } = renderStep();

    await user.click(screen.getByRole('checkbox', { name: 'Remote' }));
    const result = await getHandler()?.();

    expect(result).toBe(false);
    expect(screen.getByText('Enter your home city.')).toBeInTheDocument();
    expect(wizardApi.writeConfigDocText).not.toHaveBeenCalled();
    expect(configApi.getConfigDoc).not.toHaveBeenCalled();
  });

  it('no work type blocks the registered submit handler', async () => {
    const user = userEvent.setup();
    const { getHandler } = renderStep();

    await user.type(screen.getByLabelText('Home city'), 'Chennai');
    const result = await getHandler()?.();

    expect(result).toBe(false);
    expect(screen.getByText('Pick at least one work type.')).toBeInTheDocument();
    expect(wizardApi.writeConfigDocText).not.toHaveBeenCalled();
    expect(configApi.getConfigDoc).not.toHaveBeenCalled();
  });

  it(
    'the derived-JSON pre element matches serializeFilter(deriveFilter(...)) for a ' +
      'known persona+answers pair',
    async () => {
      const user = userEvent.setup();
      const about = baseAbout({ workTypes: ['remote'] });
      renderStep({ draft: baseDraft({ about }) });

      await screen.findByText('React');
      await user.click(screen.getByRole('button', { name: 'Staff' }));
      await user.type(screen.getByLabelText('Home city'), 'Chennai');
      await user.click(screen.getByRole('button', { name: 'Show derived filter rules' }));

      const expected = serializeFilter(
        deriveFilter({
          persona: FRONTEND_PERSONA,
          about: {
            ...about,
            seniority: ['Staff'],
            locations: [{ city: 'Chennai', country: '' }],
          },
        }),
      );
      expect(screen.getByTestId('wizard-derived-json').textContent).toBe(expected);
    },
  );

  it(
    'the registered submit handler issues exactly two PUTs in the order ' +
      'resume.json then filter.json and resolves true',
    async () => {
      const user = userEvent.setup();
      stubGuardPasses();
      vi.mocked(wizardApi.writeConfigDocText).mockResolvedValue(undefined);
      const { getHandler } = renderStep();

      await fillValidRequiredFields(user);
      const result = await getHandler()?.();

      expect(result).toBe(true);
      expect(wizardApi.writeConfigDocText).toHaveBeenCalledTimes(2);
      expect(vi.mocked(wizardApi.writeConfigDocText).mock.calls[0]?.[1]).toBe(
        'resume.json',
      );
      expect(vi.mocked(wizardApi.writeConfigDocText).mock.calls[1]?.[1]).toBe(
        'filter.json',
      );
    },
  );

  it(
    'a 422 on the first PUT rejects the registered submit handler with the server ' +
      'message and never issues the second PUT',
    async () => {
      const user = userEvent.setup();
      stubGuardPasses();
      vi.mocked(wizardApi.writeConfigDocText).mockRejectedValueOnce(
        new Error('yoe must be a whole number'),
      );
      const { getHandler } = renderStep();

      await fillValidRequiredFields(user);
      const handler = getHandler();
      await expect(handler?.()).rejects.toThrow('yoe must be a whole number');
      expect(wizardApi.writeConfigDocText).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'a pre-existing non-empty filter.json shows the wizard-existing-config notice, ' +
      'resolves false, and issues no PUT',
    async () => {
      const user = userEvent.setup();
      vi.mocked(configApi.getConfigDoc).mockResolvedValue({ text: '{"title":{}}' });
      const { getHandler } = renderStep();

      await fillValidRequiredFields(user);
      const result = await getHandler()?.();

      expect(result).toBe(false);
      expect(await screen.findByTestId('wizard-existing-config')).toHaveTextContent(
        'This profile already has filter rules. Edit them in Settings.',
      );
      expect(wizardApi.writeConfigDocText).not.toHaveBeenCalled();
    },
  );

  it(
    'a pre-existing non-empty resume.json alone (filter.json still the seeded {}) ' +
      'also shows the wizard-existing-config notice and issues no PUT',
    async () => {
      const user = userEvent.setup();
      vi.mocked(configApi.getConfigDoc).mockImplementation((_profile, doc) =>
        Promise.resolve({
          text: doc === 'resume.json' ? '{"current_yoe":5}' : '{}',
        }),
      );
      const { getHandler } = renderStep();

      await fillValidRequiredFields(user);
      const result = await getHandler()?.();

      expect(result).toBe(false);
      expect(await screen.findByTestId('wizard-existing-config')).toHaveTextContent(
        'This profile already has filter rules. Edit them in Settings.',
      );
      expect(wizardApi.writeConfigDocText).not.toHaveBeenCalled();
    },
  );

  it(
    'a successful submit reports wroteAbout: true through onDraftChange, and a ' +
      'second submit on a draft carrying wroteAbout: true skips the guard read ' +
      'entirely (regression: Back then Next must be able to re-submit)',
    async () => {
      const user = userEvent.setup();
      stubGuardPasses();
      vi.mocked(wizardApi.writeConfigDocText).mockResolvedValue(undefined);
      const onDraftChange = vi.fn();
      const { getHandler, unmount } = renderStep({ onDraftChange });

      await fillValidRequiredFields(user);
      const firstResult = await getHandler()?.();
      expect(firstResult).toBe(true);
      const lastCall = onDraftChange.mock.calls.at(-1)?.[0];
      expect(lastCall?.wroteAbout).toBe(true);

      // Unmount before re-rendering: this simulates Back navigating away
      // from step 3 (WizardPage never renders two `Step3About` instances
      // at once) and avoids duplicate-label ambiguity from two mounted
      // copies of the same form.
      unmount();

      // Simulate the real Back-then-Next round trip: the guard's own docs
      // now contain THIS session's own write (never empty, never '{}'),
      // which is exactly the state that used to trip the guard forever.
      vi.mocked(configApi.getConfigDoc).mockResolvedValue({
        text: '{"title":{}}',
      });
      vi.mocked(configApi.getConfigDoc).mockClear();
      vi.mocked(wizardApi.writeConfigDocText).mockClear();

      // The carried-over draft already has valid required fields from the
      // first submit (home city + a work type) — no need to re-fill them.
      const { getHandler: getSecondHandler } = renderStep({
        draft: { ...lastCall, wroteAbout: true },
        onDraftChange,
      });
      const secondResult = await getSecondHandler()?.();

      expect(secondResult).toBe(true);
      expect(configApi.getConfigDoc).not.toHaveBeenCalled();
      expect(wizardApi.writeConfigDocText).toHaveBeenCalledTimes(2);
    },
  );
});
