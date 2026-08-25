import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WhereYouWorkRulesCard } from './WhereYouWorkRulesCard';

describe('WhereYouWorkRulesCard', () => {
  it('renders the card title/subtitle and existing locations + timezone rule chips', () => {
    render(
      <WhereYouWorkRulesCard
        locations={[{ city: 'Chennai', country: 'India', workTypes: ['onsite'] }]}
        onLocationsChange={vi.fn()}
        timezonesRule={{ accept: ['APAC'], severity: 'hard' }}
        onTimezonesRuleChange={vi.fn()}
        errors={{}}
      />,
    );
    expect(
      screen.getByText('Rules — a job that fails these is dropped'),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-qa="geo-rules-card"]')?.textContent).toContain(
      'Applied during filter. A dropped job never reaches your board.',
    );
    expect(screen.getByDisplayValue('Chennai')).toBeInTheDocument();
    expect(screen.getByText('APAC')).toBeInTheDocument();
    expect(document.querySelector('[data-qa="geo-timezones-rule"]')).not.toBeNull();
  });

  it('renders the empty-rules state when locations and the timezone rule are both empty, and [Add] seeds one LocationRow', async () => {
    const onLocationsChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WhereYouWorkRulesCard
        locations={[]}
        onLocationsChange={onLocationsChange}
        timezonesRule={undefined}
        onTimezonesRuleChange={vi.fn()}
        errors={{}}
      />,
    );
    expect(
      screen.getByText('No rules — nothing is dropped for this reason'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onLocationsChange).toHaveBeenCalledWith([
      { city: '', country: '', workTypes: [] },
    ]);
  });

  it('does not render the empty state once a location or a timezone chip exists', () => {
    render(
      <WhereYouWorkRulesCard
        locations={[]}
        onLocationsChange={vi.fn()}
        timezonesRule={{ accept: ['APAC'], severity: 'hard' }}
        onTimezonesRuleChange={vi.fn()}
        errors={{}}
      />,
    );
    expect(
      screen.queryByText('No rules — nothing is dropped for this reason'),
    ).not.toBeInTheDocument();
  });

  it('adding a chip to the timezone rule input calls onTimezonesRuleChange with the accumulated accept list, materializing severity hard when previously undefined', async () => {
    const onTimezonesRuleChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WhereYouWorkRulesCard
        locations={[{ city: 'Chennai', country: '', workTypes: ['onsite'] }]}
        onLocationsChange={vi.fn()}
        timezonesRule={undefined}
        onTimezonesRuleChange={onTimezonesRuleChange}
        errors={{}}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Allowed timezones rule' });
    await user.type(input, 'APAC');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onTimezonesRuleChange).toHaveBeenCalledWith({
      accept: ['APAC'],
      severity: 'hard',
    });
  });

  it('changing the severity select calls onTimezonesRuleChange with the new severity, preserving the accept list', async () => {
    const onTimezonesRuleChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WhereYouWorkRulesCard
        locations={[]}
        onLocationsChange={vi.fn()}
        timezonesRule={{ accept: ['APAC'], severity: 'hard' }}
        onTimezonesRuleChange={onTimezonesRuleChange}
        errors={{}}
      />,
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Timezone rule severity' }),
      'soft',
    );
    expect(onTimezonesRuleChange).toHaveBeenCalledWith({
      accept: ['APAC'],
      severity: 'soft',
    });
  });
});
