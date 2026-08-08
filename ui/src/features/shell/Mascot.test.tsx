import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Mascot } from './Mascot';
import type { MascotState } from './mascotState';

const CASES: { state: MascotState; label: string }[] = [
  { state: 'asleep', label: 'Bunny is asleep' },
  { state: 'ears-up', label: 'Bunny is waiting for the daemon' },
  { state: 'hopping', label: 'Bunny is running the pipeline' },
  { state: 'celebrating', label: 'Bunny found new matches' },
];

describe('Mascot', () => {
  for (const { state, label } of CASES) {
    it(`renders the ${state} state`, () => {
      render(<Mascot state={state} />);
      expect(screen.getByTestId('mascot')).toHaveAttribute('data-state', state);
      expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
    });
  }
});
