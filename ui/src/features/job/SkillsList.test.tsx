import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SkillsList } from './SkillsList';

const TWELVE_SKILLS = [
  'Kubernetes',
  'Go',
  'PostgreSQL',
  'Terraform',
  'AWS',
  'gRPC',
  'CI/CD',
  'System design',
  'React',
  'TypeScript',
  'GraphQL',
  'Redis',
];

describe('SkillsList — 12 skills', () => {
  it('shows exactly 8 badges + a +4 more button; clicking reveals all 12 and flips aria-expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(<SkillsList skills={TWELVE_SKILLS} />);

    const root = container.querySelector('[data-qa="skills"]');
    expect(root).not.toBeNull();
    expect(screen.getByText('SKILLS ASKED FOR · 12')).toBeInTheDocument();

    expect((root as HTMLElement).querySelectorAll('[data-slot="badge"]')).toHaveLength(8);

    const more = screen.getByRole('button', { name: '+4 more' });
    expect(more.getAttribute('data-qa')).toBe('skills-more');
    expect(more).toHaveAttribute('aria-expanded', 'false');

    await user.click(more);

    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect((root as HTMLElement).querySelectorAll('[data-slot="badge"]')).toHaveLength(
      12,
    );
  });
});

describe('SkillsList — 0 skills', () => {
  it('renders the muted-line fallback, no badges, no toggle button', () => {
    const { container } = render(<SkillsList skills={[]} />);

    expect(container.querySelector('[data-qa="skills"]')).not.toBeNull();
    expect(screen.getByText('No skills extracted.')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(0);
    expect(container.querySelector('[data-qa="skills-more"]')).toBeNull();
  });
});
