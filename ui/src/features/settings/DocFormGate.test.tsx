import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocFormGate } from './DocFormGate';

describe('DocFormGate', () => {
  it('renders a loading state and no children while isLoading is true', () => {
    render(
      <DocFormGate doc="profile.json" isLoading loadError={null} parseError={false}>
        <button type="button">Save</button>
      </DocFormGate>,
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders a blocking load-error state and no children when loadError is set', () => {
    render(
      <DocFormGate
        doc="profile.json"
        isLoading={false}
        loadError={new Error('network error')}
        parseError={false}
      >
        <button type="button">Save</button>
      </DocFormGate>,
    );
    expect(screen.getByTestId('settings-load-error')).toHaveTextContent(
      "Couldn't load profile.json: network error",
    );
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders a blocking parse-error state and no children when parseError is set', () => {
    render(
      <DocFormGate doc="filter.json" isLoading={false} loadError={null} parseError>
        <button type="button">Save</button>
      </DocFormGate>,
    );
    expect(screen.getByTestId('settings-load-error')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders children once loaded successfully with no error', () => {
    render(
      <DocFormGate
        doc="profile.json"
        isLoading={false}
        loadError={null}
        parseError={false}
      >
        <button type="button">Save</button>
      </DocFormGate>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
