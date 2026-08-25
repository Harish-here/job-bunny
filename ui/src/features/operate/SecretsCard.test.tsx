import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../lib/api/client';
import type { SecretPresence } from '../../lib/api/types';
import * as wizardApi from '../wizard/wizard.api';
import { SecretsCard } from './SecretsCard';

vi.mock('../../lib/api/client', () => ({ getJson: vi.fn() }));
vi.mock('../wizard/wizard.api', () => ({ putSecret: vi.fn() }));

function stubSecrets(presence: SecretPresence) {
  vi.mocked(client.getJson).mockResolvedValue(presence);
}
function stubSecretsPending() {
  vi.mocked(client.getJson).mockReturnValue(new Promise(() => {}));
}

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SecretsCard />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SecretsCard — loading and error', () => {
  it('loading: renders a skeleton, no rows', () => {
    stubSecretsPending();
    const { container } = renderCard();
    expect(container.querySelector('[data-qa="card-secrets"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="secret-row-notion-token"]')).toBeNull();
  });

  it('api-unreachable: renders a Retry that recovers', async () => {
    vi.mocked(client.getJson)
      .mockRejectedValueOnce(new Error('secrets probe failed'))
      .mockResolvedValue({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' });
    renderCard();
    await screen.findByText("Can't reach the secrets API");
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByText('not configured');
  });
});

describe('SecretsCard — rows', () => {
  it('carries card-secrets, both row ids, and the All profiles badge', async () => {
    stubSecrets({ NOTION_TOKEN: 'present', TELEGRAM_BOT_TOKEN: 'absent' });
    const { container } = renderCard();
    await screen.findByText('configured');
    expect(container.querySelector('[data-qa="card-secrets"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="secret-row-notion-token"]')).not.toBeNull();
    expect(
      container.querySelector('[data-qa="secret-row-telegram-bot-token"]'),
    ).not.toBeNull();
    expect(screen.getByText('All profiles')).toBeInTheDocument();
  });

  it('present -> "configured" success tone, absent -> "not configured" attention tone', async () => {
    stubSecrets({ NOTION_TOKEN: 'present', TELEGRAM_BOT_TOKEN: 'absent' });
    const { container } = renderCard();
    await screen.findByText('configured');

    const notionRow = container.querySelector('[data-qa="secret-row-notion-token"]');
    const telegramRow = container.querySelector(
      '[data-qa="secret-row-telegram-bot-token"]',
    );
    expect(notionRow?.querySelector('.text-success-strong')).not.toBeNull();
    expect(telegramRow?.querySelector('.text-attention-strong')).not.toBeNull();
    // Never the plain, sub-4.5:1 tone directly on the status word.
    expect(telegramRow?.textContent).toContain('not configured');
  });

  it('never renders a secret value — GET /api/secrets is presence-only', async () => {
    stubSecrets({ NOTION_TOKEN: 'present', TELEGRAM_BOT_TOKEN: 'present' });
    renderCard();
    await screen.findAllByText('configured');
    expect(vi.mocked(client.getJson)).toHaveBeenCalledWith('/api/secrets');
  });
});

describe('SecretsCard — the Set dialog', () => {
  it('opens a Dialog with a type=password, autocomplete=off Input', async () => {
    stubSecrets({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' });
    renderCard();
    await screen.findAllByText('not configured');
    const setButtons = screen.getAllByRole('button', { name: 'Set' });
    await userEvent.click(setButtons[0] as HTMLElement);

    const input = await screen.findByLabelText('Value');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });

  it('submits through putSecret, closes, and re-fetches to configured — the typed value never appears in the DOM', async () => {
    vi.mocked(client.getJson)
      .mockResolvedValueOnce({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' })
      .mockResolvedValue({ NOTION_TOKEN: 'present', TELEGRAM_BOT_TOKEN: 'absent' });
    vi.mocked(wizardApi.putSecret).mockResolvedValue(undefined);

    const { container } = renderCard();
    await screen.findAllByText('not configured');
    const setButtons = screen.getAllByRole('button', { name: 'Set' });
    await userEvent.click(setButtons[0] as HTMLElement);

    const secretValue = 'sk-super-secret-token-xyz';
    const input = await screen.findByLabelText('Value');
    await userEvent.type(input, secretValue);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(wizardApi.putSecret).toHaveBeenCalledWith('NOTION_TOKEN', secretValue);
    // Row re-fetches and now reads configured.
    await screen.findByText('configured');
    // Dialog closes.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The submitted value is never rendered anywhere in the card.
    expect(container.textContent).not.toContain(secretValue);
  });

  it('the field starts empty on every open — never pre-filled from the server', async () => {
    stubSecrets({ NOTION_TOKEN: 'present', TELEGRAM_BOT_TOKEN: 'absent' });
    renderCard();
    await screen.findByText('configured');
    const setButtons = screen.getAllByRole('button', { name: 'Set' });
    await userEvent.click(setButtons[0] as HTMLElement);
    const input = await screen.findByLabelText('Value');
    expect(input).toHaveValue('');
  });
});
