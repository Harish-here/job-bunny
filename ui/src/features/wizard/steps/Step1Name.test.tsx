import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/client';
import * as configApi from '../../settings/config.api';
import { emptyDraft, type WizardDraft } from '../wizard.types';
import { Step1Name } from './Step1Name';

vi.mock('../../settings/config.api', () => ({
  createProfile: vi.fn(),
}));

function baseDraft(): WizardDraft {
  return { ...emptyDraft(''), step: 1 };
}

function renderStep(draft: WizardDraft, onDraftChange = vi.fn()) {
  let handler: (() => Promise<boolean>) | null = null;
  const registerSubmit = vi.fn((h: (() => Promise<boolean>) | null) => {
    handler = h;
  });
  const utils = render(
    <Step1Name
      draft={draft}
      onDraftChange={onDraftChange}
      registerSubmit={registerSubmit}
    />,
  );
  return { ...utils, onDraftChange, registerSubmit, getHandler: () => handler };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Step1Name', () => {
  it('shows the invalid-name message and never registers a submit handler', async () => {
    const { getHandler } = renderStep(baseDraft());
    const input = screen.getByLabelText('Profile name');
    await userEvent.type(input, 'Bad Name!');

    expect(
      screen.getByText('Use lowercase letters, digits, underscores, and hyphens only.'),
    ).toBeInTheDocument();
    // typing was never blocked
    expect(input).toHaveValue('Bad Name!');
    // no registered handler is what leaves the shared wizard-next disabled
    expect(getHandler()).toBeNull();
  });

  it('a successful create calls createProfile, updates the draft, and resolves true', async () => {
    vi.mocked(configApi.createProfile).mockResolvedValue({
      profile: { name: 'newprof', connector: 'sqlite', hasDb: true },
    });
    const { onDraftChange, getHandler } = renderStep(baseDraft());
    const input = screen.getByLabelText('Profile name');
    await userEvent.type(input, 'newprof');

    expect(getHandler()).not.toBeNull();
    await expect(getHandler()!()).resolves.toBe(true);
    expect(configApi.createProfile).toHaveBeenCalledWith('newprof');
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'newprof' }),
    );
  });

  it('a duplicate-name error lands on the field, never thrown to the step-level alert', async () => {
    vi.mocked(configApi.createProfile).mockRejectedValue(
      new ApiError(409, 'profile_exists', 'profile already exists: rajni'),
    );
    const { getHandler } = renderStep(baseDraft());
    const input = screen.getByLabelText('Profile name');
    await userEvent.type(input, 'rajni');

    await expect(getHandler()!()).resolves.toBe(false);
    expect(await screen.findByText('profile already exists: rajni')).toBeInTheDocument();
  });

  it('a non-duplicate server error propagates out of the handler for the shell to catch', async () => {
    vi.mocked(configApi.createProfile).mockRejectedValue(
      new ApiError(500, 'internal', "The board couldn't be reached."),
    );
    const { getHandler } = renderStep(baseDraft());
    const input = screen.getByLabelText('Profile name');
    await userEvent.type(input, 'newprof');

    await expect(getHandler()!()).rejects.toThrow("The board couldn't be reached.");
  });

  it('when draft.profile is already set, the field is locked and the handler resolves true without a second createProfile call', async () => {
    const draft: WizardDraft = { ...emptyDraft('already-created'), step: 1 };
    const { getHandler } = renderStep(draft);
    const input = screen.getByLabelText('Profile name');

    expect(input).toBeDisabled();
    expect(input).toHaveValue('already-created');
    await expect(getHandler()!()).resolves.toBe(true);
    expect(configApi.createProfile).not.toHaveBeenCalled();
  });
});
