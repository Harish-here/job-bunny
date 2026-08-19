import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsShell } from './SettingsShell';

vi.mock('../../lib/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/router')>();
  return { ...actual, navigate: vi.fn() };
});

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
});
