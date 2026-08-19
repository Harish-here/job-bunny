import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../../lib/router';
import { SettingsNav } from './SettingsNav';
import { DirtyNavGuard } from './save/DirtyNavGuard';

vi.mock('../../lib/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/router')>();
  return { ...actual, navigate: vi.fn() };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SettingsNav', () => {
  it('renders 4 groups with 12 links total, one active with aria-current="page"', () => {
    render(<SettingsNav section="skills" navigate={navigate} />);
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    expect(
      document.querySelector('[data-qa="settings-nav-group-aim"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-qa="settings-nav-group-runs"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-qa="settings-nav-group-output"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-qa="settings-nav-group-advanced"]'),
    ).toBeInTheDocument();

    const links = screen.getAllByRole('button');
    expect(links).toHaveLength(12);

    const active = screen.getByRole('button', { name: 'Skills' });
    expect(active).toHaveAttribute('aria-current', 'page');
    for (const link of links) {
      if (link !== active) expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('clicking a link with a clean state navigates directly (spy-asserted)', async () => {
    const user = userEvent.setup();
    render(
      <DirtyNavGuard isDirty={false} navigate={navigate} save={vi.fn()} discard={vi.fn()}>
        {(go) => <SettingsNav section="landing" navigate={go} />}
      </DirtyNavGuard>,
    );
    await user.click(screen.getByRole('button', { name: 'Roles & companies' }));
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'roles-companies',
    });
  });

  it('clicking a link with a dirty state is intercepted by DirtyNavGuard instead of navigating', async () => {
    const user = userEvent.setup();
    render(
      <DirtyNavGuard isDirty={true} navigate={navigate} save={vi.fn()} discard={vi.fn()}>
        {(go) => <SettingsNav section="landing" navigate={go} />}
      </DirtyNavGuard>,
    );
    await user.click(screen.getByRole('button', { name: 'Roles & companies' }));
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
    expect(screen.getByTestId('dirty-nav-dialog')).toBeInTheDocument();
  });

  it('the landing link targets {name:"settings", section:"landing"} — the same navigate() path every other link uses', async () => {
    const user = userEvent.setup();
    render(<SettingsNav section="danger" navigate={navigate} />);
    await user.click(screen.getByRole('button', { name: 'What decides your board' }));
    expect(vi.mocked(navigate)).toHaveBeenCalledWith({
      name: 'settings',
      section: 'landing',
    });
  });

  it('ArrowDown/ArrowUp move focus between links, wrapping at the ends', async () => {
    const user = userEvent.setup();
    render(<SettingsNav section="landing" navigate={navigate} />);
    const first = screen.getByRole('button', { name: 'What decides your board' });
    const second = screen.getByRole('button', { name: 'Roles & companies' });
    const last = screen.getByRole('button', { name: 'Danger zone' });

    first.focus();
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(last).toHaveFocus();
  });

  it('only the focused/active link is tabbable; the rest carry tabIndex=-1', () => {
    render(<SettingsNav section="skills" navigate={navigate} />);
    const links = screen.getAllByRole('button');
    const active = screen.getByRole('button', { name: 'Skills' });
    for (const link of links) {
      expect(link).toHaveAttribute('tabIndex', link === active ? '0' : '-1');
    }
  });
});
