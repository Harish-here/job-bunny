import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EligibilityGrid } from './EligibilityGrid';

describe('EligibilityGrid — all populated', () => {
  it('renders 4 cells with the labels and given values', () => {
    const { container } = render(
      <EligibilityGrid
        locationCity="Bengaluru"
        workType="Hybrid"
        seniority="Senior"
        timezone="IST"
      />,
    );

    const card = container.querySelector('[data-qa="eligibility"]');
    expect(card).not.toBeNull();
    expect(screen.getByText('Eligibility')).toBeInTheDocument();
    for (const label of ['LOCATION', 'WORK TYPE', 'SENIORITY', 'TIMEZONE']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Bengaluru')).toBeInTheDocument();
    expect(screen.getByText('Hybrid')).toBeInTheDocument();
    expect(screen.getByText('Senior')).toBeInTheDocument();
    expect(screen.getByText('IST')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});

describe('EligibilityGrid — all null', () => {
  it('still renders 4 cells, each showing an em dash', () => {
    render(
      <EligibilityGrid
        locationCity={null}
        workType={null}
        seniority={null}
        timezone={null}
      />,
    );

    expect(screen.getByText('Eligibility')).toBeInTheDocument();
    for (const label of ['LOCATION', 'WORK TYPE', 'SENIORITY', 'TIMEZONE']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('—')).toHaveLength(4);
  });
});
