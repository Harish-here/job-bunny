import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../lib/router';
import { SettingsShell } from './SettingsShell';
import {
  SettingsSaveProvider,
  useRegisterSettingsSave,
} from './save/SettingsSaveContext';

vi.mock('../../lib/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/router')>();
  return { ...actual, navigate: vi.fn() };
});

// A minimal stand-in for a dirty SaveBar-owning section — registers itself
// with the real `SettingsSaveProvider` exactly like `RolesCompaniesSection`
// etc. do, without dragging in a whole section's own doc-form plumbing.
function DirtyRegistrant() {
  useRegisterSettingsSave({
    isDirty: true,
    save: vi.fn().mockResolvedValue(true),
    discard: vi.fn(),
  });
  return null;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SettingsShell', () => {
  it('renders with section="landing": the landing nav item is active (aria-current="page") and every other item is not', () => {
    render(
      <SettingsShell section="landing" profile="rajni">
        <p>body</p>
      </SettingsShell>,
    );
    const active = screen.getByRole('button', { name: 'What decides your board' });
    expect(active).toHaveAttribute('aria-current', 'page');
    for (const link of screen.getAllByRole('button')) {
      if (link !== active) expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('renders the settings-shell root and preserves the settings-section/data-section contract', () => {
    render(
      <SettingsShell section="skills" profile="rajni">
        <p>skills body</p>
      </SettingsShell>,
    );
    expect(document.querySelector('[data-qa="settings-shell"]')).toBeInTheDocument();
    const wrapper = screen.getByTestId('settings-section');
    expect(wrapper).toHaveAttribute('data-section', 'skills');
    expect(wrapper).toHaveTextContent('skills body');
  });

  it('renders scope-chip-profile with the given profile name', () => {
    render(
      <SettingsShell section="landing" profile="harish">
        <p>body</p>
      </SettingsShell>,
    );
    expect(document.querySelector('[data-qa="scope-chip-profile"]')).toHaveTextContent(
      'Profile: harish',
    );
  });

  it('a dirty registered section intercepts SettingsNav navigation with the unsaved-changes dialog, instead of navigating immediately (cross-section dirty-nav guard)', async () => {
    render(
      <SettingsSaveProvider>
        <DirtyRegistrant />
        <SettingsShell section="landing" profile="rajni">
          <p>body</p>
        </SettingsShell>
      </SettingsSaveProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Roles & companies' }));
    expect(await screen.findByTestId('dirty-nav-dialog')).toBeInTheDocument();
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });
});
