import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configApi from '../config.api';
import { ResumeSection } from './ResumeSection';

vi.mock('../config.api', () => ({
  getConfigDoc: vi.fn(),
  putConfigDoc: vi.fn(),
}));

const RAJNI_RESUME = {
  current_yoe: 9,
  target_seniority: ['Staff', 'Lead'],
  core_skills: ['React', 'TypeScript'],
  secondary_skills: ['Vue.js'],
  preferred_work_type: ['Remote', 'Hybrid'],
  location: ['Chennai', 'Bengaluru'],
  domain_experience: ['Enterprise SaaS', 'Fintech'],
  usp: ['Led the UI platform re-architecture behind a multi-brand storefront rollout.'],
  full_resume: {
    name: 'Rajni Test Profile',
    skills: [
      { category: 'Languages & Frameworks', items: 'TypeScript, JavaScript, React.' },
    ],
  },
};

function renderSection(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ResumeSection profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ResumeSection', () => {
  it('renders current_yoe and an existing core skill from the loaded doc', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: JSON.stringify(RAJNI_RESUME),
    });
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText('Current years of experience')).toHaveValue('9');
    });
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('adding a core skill includes it in the save payload', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: JSON.stringify(RAJNI_RESUME),
    });
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '' });
    renderSection();
    await waitFor(() => expect(screen.getByText('React')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Add to Core skills'), 'GraphQL');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalled());
    const [, , text] = vi.mocked(configApi.putConfigDoc).mock.calls[0]!;
    expect(JSON.parse(text as string).core_skills).toEqual([
      'React',
      'TypeScript',
      'GraphQL',
    ]);
  });

  it('an out-of-range current_yoe shows an inline error and blocks Save', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: JSON.stringify(RAJNI_RESUME),
    });
    renderSection();
    const yoeField = await screen.findByLabelText('Current years of experience');
    await userEvent.clear(yoeField);
    await userEvent.type(yoeField, '70');

    expect(
      await screen.findByText(
        'Enter years of experience as a whole number from 0 to 60.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(configApi.putConfigDoc).not.toHaveBeenCalled();
  });

  it('saving preserves usp and full_resume byte-for-value in the PUT payload', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: JSON.stringify(RAJNI_RESUME),
    });
    vi.mocked(configApi.putConfigDoc).mockResolvedValue({ text: '' });
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText('Current years of experience')).toHaveValue('9');
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(configApi.putConfigDoc).toHaveBeenCalled());
    const [, , text] = vi.mocked(configApi.putConfigDoc).mock.calls[0]!;
    const written = JSON.parse(text as string);
    expect(written.usp).toEqual(RAJNI_RESUME.usp);
    expect(written.full_resume).toEqual(RAJNI_RESUME.full_resume);
  });

  it('a server rejection renders the message via data-testid settings-error', async () => {
    vi.mocked(configApi.getConfigDoc).mockResolvedValue({
      text: JSON.stringify(RAJNI_RESUME),
    });
    vi.mocked(configApi.putConfigDoc).mockRejectedValue(
      new Error('resume.json is not valid JSON: unexpected token'),
    );
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText('Current years of experience')).toHaveValue('9');
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('settings-error')).toHaveTextContent(
      'resume.json is not valid JSON: unexpected token',
    );
  });
});
