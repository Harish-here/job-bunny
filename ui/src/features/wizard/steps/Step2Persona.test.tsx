import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wizardApi from '../wizard.api';
import { emptyDraft, type Persona, type PersonaCatalog } from '../wizard.types';
import { Step2Persona } from './Step2Persona';

vi.mock('../wizard.api', () => ({
  getPersonas: vi.fn(),
}));

const PERSONA_IDS = [
  'frontend',
  'backend',
  'fullstack',
  'data',
  'devops',
  'product',
  'design',
  'csm',
  'sales',
  'marketing',
  'scratch',
] as const;

function makePersona(id: (typeof PERSONA_IDS)[number]): Persona {
  const isScratch = id === 'scratch';
  return {
    id,
    label: isScratch ? 'Start from scratch' : id,
    blurb: isScratch ? 'No preset — pick everything yourself.' : `${id} roles`,
    coreSkills: isScratch ? [] : ['Skill A', 'Skill B'],
    secondarySkills: isScratch ? [] : ['Skill C'],
    seniorityOptions: isScratch ? [] : ['Staff', 'Lead'],
    title: {
      domain: { match: isScratch ? [] : [id], reject: [] },
      function: { match: isScratch ? [] : ['engineer'], reject: [] },
    },
  };
}

const CATALOG: PersonaCatalog = { version: 1, personas: PERSONA_IDS.map(makePersona) };

function renderStep(personaId: string | null, onDraftChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let handler: (() => Promise<boolean>) | null = null;
  const registerSubmit = vi.fn((h: (() => Promise<boolean>) | null) => {
    handler = h;
  });
  function Wrapper({ id }: { id: string | null }) {
    const draft = { ...emptyDraft('wiz-test'), personaId: id };
    return (
      <QueryClientProvider client={qc}>
        <Step2Persona
          draft={draft}
          onDraftChange={onDraftChange}
          registerSubmit={registerSubmit}
        />
      </QueryClientProvider>
    );
  }
  const utils = render(<Wrapper id={personaId} />);
  return {
    ...utils,
    onDraftChange,
    getHandler: () => handler,
    rerenderWithId: (id: string | null) => utils.rerender(<Wrapper id={id} />),
  };
}

async function findPersonaCard(id: string) {
  const cards = await screen.findAllByTestId('wizard-persona');
  const card = cards.find((c) => c.getAttribute('data-persona-id') === id);
  if (!card) throw new Error(`persona card not found: ${id}`);
  return card;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Step2Persona', () => {
  it('renders 11 cards from a mocked catalog, in catalog order', async () => {
    vi.mocked(wizardApi.getPersonas).mockResolvedValue(CATALOG);
    renderStep(null);

    const cards = await screen.findAllByTestId('wizard-persona');
    expect(cards).toHaveLength(11);
    expect(cards.map((c) => c.getAttribute('data-persona-id'))).toEqual([...PERSONA_IDS]);
  });

  it('selecting a card calls onDraftChange, and once selected the registered handler resolves true', async () => {
    vi.mocked(wizardApi.getPersonas).mockResolvedValue(CATALOG);
    const { onDraftChange, getHandler, rerenderWithId } = renderStep(null);

    const frontendCard = await findPersonaCard('frontend');
    await userEvent.click(frontendCard);

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'frontend' }),
    );
    // this isolated render is controlled: clicking reports the change but
    // doesn't mutate `draft` itself — a real `WizardPage` applies it and
    // re-renders with the new `personaId`, simulated here via rerender.
    expect(getHandler()).toBeNull();

    rerenderWithId('frontend');
    expect(getHandler()).not.toBeNull();
    await expect(getHandler()!()).resolves.toBe(true);

    const updated = await findPersonaCard('frontend');
    expect(updated).toHaveAttribute('aria-pressed', 'true');
    const other = await findPersonaCard('backend');
    expect(other).toHaveAttribute('aria-pressed', 'false');
  });

  it('scratch pre-fills nothing: onDraftChange receives empty skill arrays', async () => {
    vi.mocked(wizardApi.getPersonas).mockResolvedValue(CATALOG);
    const { onDraftChange } = renderStep(null);

    const scratchCard = await findPersonaCard('scratch');
    await userEvent.click(scratchCard);

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: 'scratch',
        about: expect.objectContaining({ coreSkills: [], secondarySkills: [] }),
      }),
    );
  });

  it('a failed personas query shows plain inline text, not the wizard-error alert, and registers no submit handler', async () => {
    vi.mocked(wizardApi.getPersonas).mockRejectedValue(new Error('boom'));
    const { getHandler } = renderStep(null);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(getHandler()).toBeNull();
  });
});
