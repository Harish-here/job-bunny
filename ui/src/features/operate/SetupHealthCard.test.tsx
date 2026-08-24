import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DoctorFinding, DoctorReport } from './operate.api';
import * as operateApi from './operate.api';
import { SetupHealthCard } from './SetupHealthCard';

vi.mock('./operate.api', async () => {
  const actual = await vi.importActual<typeof import('./operate.api')>('./operate.api');
  return { ...actual, getDoctorReport: vi.fn() };
});

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

function stubDoctor(findings: DoctorFinding[]) {
  const report: DoctorReport = { status: 'ok', findings };
  vi.mocked(operateApi.getDoctorReport).mockResolvedValue(report);
}

function renderCard(profile = 'rajni') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SetupHealthCard profile={profile} />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const OK_FINDINGS: DoctorFinding[] = [
  { check: 'profile-parses', status: 'ok', detail: 'profile.json parses' },
  { check: 'filter-parses', status: 'ok', detail: 'filter.json valid' },
];

describe('SetupHealthCard', () => {
  it('collapses to one line with zero visible finding rows when every check passes', async () => {
    stubDoctor(OK_FINDINGS);
    renderCard();

    await screen.findByText('Setup complete · 2/2 checks passing');
    expect(screen.queryByTestId('health-row-profile-parses')).not.toBeInTheDocument();
    expect(document.querySelector('[data-qa="health-row-profile-parses"]')).toBeNull();
    expect(document.querySelector('[data-qa="health-group-needs-action"]')).toBeNull();
    expect(document.querySelector('[data-qa="health-group-not-configured"]')).toBeNull();
  });

  it('reveals the ok findings once the disclosure is opened', async () => {
    stubDoctor(OK_FINDINGS);
    renderCard();

    const trigger = await screen.findByText('Setup complete · 2/2 checks passing');
    await userEvent.click(trigger);

    expect(
      document.querySelector('[data-qa="health-row-profile-parses"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-qa="health-group-ok"]')).not.toBeNull();
  });

  it('renders a Copy button for a warn finding with a cli-command destination and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    stubDoctor([
      { check: 'daemon-liveness', status: 'warn', detail: 'daemon pidfile not found' },
    ]);
    renderCard();

    const cell = await screen.findByText(/daemon pidfile not found/);
    expect(cell).toBeInTheDocument();

    const copyButton = screen.getByRole('button', {
      name: 'Copy: jobbunny serve start',
    });
    await userEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('jobbunny serve start');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('groups a warn settings-link finding under health-group-needs-action and navigates on click', async () => {
    stubDoctor([
      { check: 'notion-db-reachable', status: 'warn', detail: 'token missing' },
    ]);
    renderCard();

    await screen.findByText('token missing');
    const group = document.querySelector('[data-qa="health-group-needs-action"]');
    expect(group).not.toBeNull();
    const row = within(group as HTMLElement).getByText('token missing');
    expect(row).toBeInTheDocument();
    expect(document.querySelector('[data-qa="health-group-not-configured"]')).toBeNull();

    window.location.hash = '';
    await userEvent.click(
      within(group as HTMLElement).getByRole('button', { name: 'Settings' }),
    );
    expect(window.location.hash).toBe('#/settings/delivery');
  });

  it('shows an error state with a retry control when the doctor request fails', async () => {
    vi.mocked(operateApi.getDoctorReport).mockRejectedValue(new Error('network down'));
    renderCard();

    expect(await screen.findByText("Can't reach the doctor API")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('navigates to the onboarding wizard from the footer "Set up a new profile" button', async () => {
    stubDoctor(OK_FINDINGS);
    renderCard();
    await screen.findByText('Setup complete · 2/2 checks passing');

    window.location.hash = '';
    await userEvent.click(screen.getByRole('button', { name: 'Set up a new profile' }));
    expect(window.location.hash).toBe('#/onboarding');
  });
});
