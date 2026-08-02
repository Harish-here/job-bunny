import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardJobRow, TrackingRow } from '../../lib/api/types';
import { boardKeys } from '../board/board.queries';
import { TrackingPanel } from './TrackingPanel';

beforeAll(() => {
  // radix Select needs these in jsdom; nothing under test exercises them.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeJob(tracking: TrackingRow | null): BoardJobRow {
  return {
    id: 'li-1',
    lane: 'linkedin',
    title: 'Senior Engineer',
    company: 'Acme',
    url: 'https://acme.example/jobs/1',
    seniority: 'Senior',
    locationCity: 'Remote',
    workType: 'remote',
    timezone: 'IST',
    skills: [],
    excitement: null,
    score: 88,
    matchReasons: [],
    reviewFlags: [],
    dateFound: '2026-08-01T00:00:00.000Z',
    archived: false,
    tracking,
  };
}

function renderPanel(job: BoardJobRow): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(boardKeys.meta('rajni'), {
    statusOptions: ['Lead', 'Applied', 'Rejected'],
    excitementOptions: ['Vera level'],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<TrackingPanel profile="rajni" job={job} />, { wrapper });
}

function stubFetchOk(body: unknown) {
  const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => body }) as unknown);
  vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
  return fetchSpy;
}

function stubFetchPending() {
  let resolve!: (body: unknown) => void;
  const pending = new Promise((res) => {
    resolve = (body: unknown) => res({ ok: true, json: async () => body });
  });
  const fetchSpy = vi.fn(() => pending);
  vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
  return { fetchSpy, resolve };
}

describe('TrackingPanel', () => {
  it('renders current tracking values', () => {
    stubFetchOk({});
    const job = makeJob({
      jobId: 'li-1',
      updatedAt: 't0',
      status: 'Applied',
      dateApplied: '2026-08-01',
      compRange: '20-25 LPA',
      contact: 'jane@acme.example',
      nextAction: 'follow up',
      nextActionDate: '2026-08-10',
      notes: 'phone screen booked',
    });
    renderPanel(job);

    expect(screen.getByLabelText('Status')).toHaveTextContent('Applied');
    expect(screen.getByLabelText('Date applied')).toHaveValue('2026-08-01');
    expect(screen.getByLabelText('Comp range')).toHaveValue('20-25 LPA');
    expect(screen.getByLabelText('Contact')).toHaveValue('jane@acme.example');
    expect(screen.getByLabelText('Next action')).toHaveValue('follow up');
    expect(screen.getByLabelText('Next action date')).toHaveValue('2026-08-10');
    expect(screen.getByLabelText('Notes')).toHaveValue('phone screen booked');
  });

  it('fires no fetch when a field is blurred with its unchanged value', async () => {
    const fetchSpy = stubFetchOk({});
    const job = makeJob({ jobId: 'li-1', updatedAt: 't0', contact: 'jane@acme.example' });
    renderPanel(job);

    const contact = screen.getByLabelText('Contact');
    await userEvent.click(contact);
    await userEvent.tab();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PATCHes {field: null} when a set field is cleared', async () => {
    const fetchSpy = stubFetchOk({
      tracking: { jobId: 'li-1', updatedAt: 't1' },
    });
    const job = makeJob({ jobId: 'li-1', updatedAt: 't0', contact: 'jane@acme.example' });
    renderPanel(job);

    const contact = screen.getByLabelText('Contact');
    await userEvent.clear(contact);
    await userEvent.tab();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/profiles/rajni/jobs/li-1/tracking');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ contact: null });
  });

  it('commits a date field on blur, not on change (partial-edit safe)', async () => {
    const fetchSpy = stubFetchOk({
      tracking: { jobId: 'li-1', updatedAt: 't1', dateApplied: '2026-08-05' },
    });
    const job = makeJob({ jobId: 'li-1', updatedAt: 't0', dateApplied: '2026-08-01' });
    renderPanel(job);

    const dateApplied = screen.getByLabelText('Date applied');
    // A native date input mid-edit briefly reports '' — change must not commit.
    fireEvent.change(dateApplied, { target: { value: '' } });
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.change(dateApplied, { target: { value: '2026-08-05' } });
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.blur(dateApplied);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1]?.body))).toEqual({ dateApplied: '2026-08-05' });
  });

  it('PATCHes the status field on select change', async () => {
    const fetchSpy = stubFetchOk({
      tracking: { jobId: 'li-1', updatedAt: 't1', status: 'Rejected' },
    });
    const job = makeJob({ jobId: 'li-1', updatedAt: 't0', status: 'Applied' });
    renderPanel(job);

    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.click(await screen.findByText('Rejected'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1]?.body))).toEqual({ status: 'Rejected' });
  });

  it('shows a Saving… indicator while the mutation is pending', async () => {
    const { resolve } = stubFetchPending();
    const job = makeJob({ jobId: 'li-1', updatedAt: 't0', contact: 'jane@acme.example' });
    renderPanel(job);

    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();

    const contact = screen.getByLabelText('Contact');
    await userEvent.clear(contact);
    await userEvent.tab();

    await waitFor(() => expect(screen.getByText('Saving…')).toBeInTheDocument());

    resolve({ tracking: { jobId: 'li-1', updatedAt: 't1' } });
    await waitFor(() => expect(screen.queryByText('Saving…')).not.toBeInTheDocument());
  });
});
