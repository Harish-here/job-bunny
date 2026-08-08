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
  render(
    <Step3About
      draft={overrides.draft ?? baseDraft()}
      onDraftChange={onDraftChange}
      registerSubmit={registerSubmit}
    />,
    { wrapper },
  );
  return { onDraftChange, registerSubmit, getHandler: () => submitHandler };
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
});
