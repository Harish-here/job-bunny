import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WhereYouWorkPrefsCard } from './WhereYouWorkPrefsCard';

// Each ChipInput renders its own "Add" button beside its own input, so a
// bare getAllByRole(...)[n] index guess is fragile — scope to the specific
// field's own input+Add wrapper instead.
function addButtonFor(inputLabel: string): HTMLElement {
  const input = screen.getByRole('textbox', { name: inputLabel });
  // biome-ignore lint/style/noNonNullAssertion: ChipInput always wraps its input+Add in a parent div
  return within(input.closest('div')!).getByRole('button', { name: 'Add' });
}

function renderCard(
  overrides: Partial<Parameters<typeof WhereYouWorkPrefsCard>[0]> = {},
) {
  const props = {
    homeCities: ['Bengaluru'],
    onHomeCitiesChange: vi.fn(),
    acceptableTimezones: ['APAC'],
    onAcceptableTimezonesChange: vi.fn(),
    borderlineTimezones: ['EMEA'],
    onBorderlineTimezonesChange: vi.fn(),
    workTypePreference: 'no-preference' as const,
    onWorkTypePreferenceChange: vi.fn(),
    ...overrides,
  };
  render(<WhereYouWorkPrefsCard {...props} />);
  return props;
}

describe('WhereYouWorkPrefsCard', () => {
  it('renders the card title/subtitle, existing chips, and the footer link to Raw config', () => {
    renderCard();
    expect(
      screen.getByText('Preferences — these change the order, never drop anything'),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-qa="geo-prefs-card"]')?.textContent).toContain(
      'Applied during rank. Nothing here can remove a job.',
    );
    expect(screen.getByText('Bengaluru')).toBeInTheDocument();
    expect(screen.getByText('APAC')).toBeInTheDocument();
    expect(screen.getByText('EMEA')).toBeInTheDocument();
    expect(document.querySelector('[data-qa="geo-timezones-acceptable"]')).not.toBeNull();
    expect(document.querySelector('[data-qa="geo-timezones-borderline"]')).not.toBeNull();
    const footerLink = screen.getByRole('link', { name: 'Raw config →' });
    expect(footerLink).toHaveAttribute('href', '#/settings/raw-config');
  });

  it('adding a chip to acceptable/borderline timezone inputs calls the matching change handler', async () => {
    const user = userEvent.setup();
    const props = renderCard({ acceptableTimezones: [], borderlineTimezones: [] });
    const acceptableInput = screen.getByRole('textbox', {
      name: 'Acceptable timezones preference',
    });
    await user.type(acceptableInput, 'America/New_York');
    await user.click(addButtonFor('Acceptable timezones preference'));
    expect(props.onAcceptableTimezonesChange).toHaveBeenCalledWith(['America/New_York']);
  });

  it('changing the work-type preference select calls onWorkTypePreferenceChange', async () => {
    const user = userEvent.setup();
    const props = renderCard();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Work-type preference' }),
      'remote-first',
    );
    expect(props.onWorkTypePreferenceChange).toHaveBeenCalledWith('remote-first');
  });
});
