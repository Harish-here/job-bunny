import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHash } from '../../lib/router';
import * as configApi from '../settings/config.api';
import { OnboardingPage } from './OnboardingPage';

vi.mock('../settings/config.api', () => ({
  createProfile: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<OnboardingPage />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = '';
});

describe('OnboardingPage', () => {
  it('disables submit when the name is empty', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('shows the hint and disables submit for an invalid name', async () => {
    renderPage();
    const input = screen.getByLabelText('Name');
    await userEvent.type(input, 'Bad Name!');

    expect(
      screen.getByText('Use lowercase letters, digits, underscores, and hyphens only.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    // typing was never blocked
    expect(input).toHaveValue('Bad Name!');
  });

  it('a successful create calls createProfile, selects the profile, and navigates to settings', async () => {
    vi.mocked(configApi.createProfile).mockResolvedValue({
      profile: { name: 'newprof', connector: 'sqlite', hasDb: true },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText('Name'), 'newprof');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(configApi.createProfile).toHaveBeenCalledWith('newprof');
    });
    await waitFor(() => {
      expect(localStorage.getItem('jobbunny.profile')).toBe('newprof');
    });
    await waitFor(() => {
      expect(parseHash(window.location.hash)).toEqual({ name: 'settings' });
    });
  });

  it('a 409 duplicate response renders its message verbatim', async () => {
    vi.mocked(configApi.createProfile).mockRejectedValue(
      new Error('profile already exists: rajni'),
    );
    renderPage();

    await userEvent.type(screen.getByLabelText('Name'), 'rajni');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('profile already exists: rajni')).toBeInTheDocument();
  });
});
