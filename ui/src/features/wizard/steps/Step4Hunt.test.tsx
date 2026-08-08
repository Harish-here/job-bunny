import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigDoc } from '../../settings/config.api';
import { serializeSearchUrls } from '../serialize';
import { patchProfileConfig, writeConfigDocText } from '../wizard.api';
import type { WizardDraft } from '../wizard.types';
import { emptyDraft } from '../wizard.types';
import { Step4Hunt } from './Step4Hunt';

vi.mock('../wizard.api', () => ({
  writeConfigDocText: vi.fn(),
  patchProfileConfig: vi.fn(),
}));

vi.mock('../../settings/config.api', () => ({
  getConfigDoc: vi.fn(),
}));

function makeDraft(): WizardDraft {
  return emptyDraft('wiz-test');
}

function makeCapture() {
  const ref: { current: (() => Promise<boolean>) | null } = { current: null };
  return {
    ref,
    registerSubmit: (handler: (() => Promise<boolean>) | null) => {
      ref.current = handler;
    },
  };
}

function Harness({
  initial = makeDraft(),
  registerSubmit,
}: {
  initial?: WizardDraft;
  registerSubmit: (handler: (() => Promise<boolean>) | null) => void;
}) {
  const [draft, setDraft] = useState<WizardDraft>(initial);
  return (
    <Step4Hunt draft={draft} onDraftChange={setDraft} registerSubmit={registerSubmit} />
  );
}

async function fillRow(index: number, url: string, label: string) {
  const urlInputs = screen.getAllByLabelText('Search URL');
  const labelInputs = screen.getAllByLabelText('Label');
  if (url !== '') await userEvent.type(urlInputs[index]!, url);
  if (label !== '') await userEvent.type(labelInputs[index]!, label);
}

async function addRow() {
  await userEvent.click(screen.getByRole('button', { name: 'Add another search URL' }));
}

async function submit(handler: (() => Promise<boolean>) | null): Promise<boolean> {
  let result = false;
  await act(async () => {
    result = await handler!();
  });
  return result;
}

beforeEach(() => {
  vi.mocked(getConfigDoc).mockResolvedValue({ text: '' });
  vi.mocked(writeConfigDocText).mockResolvedValue(undefined);
  vi.mocked(patchProfileConfig).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Step4Hunt', () => {
  it('renders exactly one empty search-URL row on mount', () => {
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    expect(screen.getAllByTestId('wizard-url-row')).toHaveLength(1);
    expect(screen.getByLabelText('Search URL')).toHaveValue('');
    expect(screen.getByLabelText('Label')).toHaveValue('');
  });

  it('adding a row renders two rows of fields', async () => {
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await addRow();
    expect(screen.getAllByTestId('wizard-url-row')).toHaveLength(2);
    expect(screen.getAllByLabelText('Search URL')).toHaveLength(2);
    expect(screen.getAllByLabelText('Label')).toHaveLength(2);
  });

  it('an http:// URL shows the exact protocol message and resolves false', async () => {
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(0, 'http://www.linkedin.com/jobs/search/', 'Frontend Roles');

    const result = await submit(capture.ref.current);

    expect(result).toBe(false);
    expect(
      await screen.findByText('Enter a LinkedIn URL starting with https://'),
    ).toBeInTheDocument();
    expect(writeConfigDocText).not.toHaveBeenCalled();
    expect(patchProfileConfig).not.toHaveBeenCalled();
  });

  it('a non-linkedin host shows the exact host message', async () => {
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(0, 'https://example.com/jobs', 'Frontend Roles');

    const result = await submit(capture.ref.current);

    expect(result).toBe(false);
    expect(
      await screen.findByText('That URL is not a linkedin.com address.'),
    ).toBeInTheDocument();
    expect(writeConfigDocText).not.toHaveBeenCalled();
    expect(patchProfileConfig).not.toHaveBeenCalled();
  });

  it('a URL without a label shows the exact label message', async () => {
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(0, 'https://www.linkedin.com/jobs/search/?keywords=frontend', '');

    const result = await submit(capture.ref.current);

    expect(result).toBe(false);
    expect(
      await screen.findByText('Give this search a short label.'),
    ).toBeInTheDocument();
    expect(writeConfigDocText).not.toHaveBeenCalled();
    expect(patchProfileConfig).not.toHaveBeenCalled();
  });

  it('a /jobs/collections/ URL shows the non-blocking warning AND still resolves true', async () => {
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(
      0,
      'https://www.linkedin.com/jobs/collections/recommended/',
      'Recommended',
    );

    expect(screen.getByTestId('wizard-url-warning')).toHaveTextContent(
      'This looks like a different LinkedIn page type; it will still be saved under ' +
        'linkedin__jobs-search.',
    );

    const result = await submit(capture.ref.current);

    expect(result).toBe(true);
    expect(writeConfigDocText).toHaveBeenCalled();
  });

  it('removing a row drops it from the payload', async () => {
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(
      0,
      'https://www.linkedin.com/jobs/search/?keywords=first',
      'First Search',
    );
    await addRow();
    await fillRow(
      1,
      'https://www.linkedin.com/jobs/search/?keywords=second',
      'Second Search',
    );

    const removeButtons = screen.getAllByRole('button', { name: 'Remove search URL' });
    await userEvent.click(removeButtons[0]!);

    expect(screen.getAllByLabelText('Search URL')).toHaveLength(1);

    const result = await submit(capture.ref.current);

    expect(result).toBe(true);
    expect(writeConfigDocText).toHaveBeenCalledWith(
      'wiz-test',
      'search_urls.md',
      serializeSearchUrls([
        {
          label: 'Second Search',
          url: 'https://www.linkedin.com/jobs/search/?keywords=second',
        },
      ]),
    );
  });

  it(
    'submitting two rows PUTs search_urls.md whose text equals serializeSearchUrls of ' +
      "those rows, then patches lanes to ['linkedin','greenhouse','keka']",
    async () => {
      const capture = makeCapture();
      render(<Harness registerSubmit={capture.registerSubmit} />);
      await fillRow(
        0,
        'https://www.linkedin.com/jobs/search/?keywords=staff',
        'Staff Frontend Engineer',
      );
      await addRow();
      await fillRow(
        1,
        'https://www.linkedin.com/jobs/search/?keywords=lead',
        'Lead Frontend Engineer',
      );

      const result = await submit(capture.ref.current);

      expect(result).toBe(true);
      const expectedEntries = [
        {
          label: 'Staff Frontend Engineer',
          url: 'https://www.linkedin.com/jobs/search/?keywords=staff',
        },
        {
          label: 'Lead Frontend Engineer',
          url: 'https://www.linkedin.com/jobs/search/?keywords=lead',
        },
      ];
      expect(writeConfigDocText).toHaveBeenCalledWith(
        'wiz-test',
        'search_urls.md',
        serializeSearchUrls(expectedEntries),
      );

      expect(patchProfileConfig).toHaveBeenCalledTimes(1);
      const [profileArg, mutateFn] = vi.mocked(patchProfileConfig).mock.calls[0]!;
      expect(profileArg).toBe('wiz-test');
      const cfg: Record<string, unknown> = {};
      mutateFn(cfg);
      expect(cfg.lanes).toEqual(['linkedin', 'greenhouse', 'keka']);
    },
  );

  it(
    'submitting with the mounted row left blank issues NO search_urls.md PUT and patches ' +
      "lanes to ['greenhouse','keka']",
    async () => {
      const capture = makeCapture();
      render(<Harness registerSubmit={capture.registerSubmit} />);

      const result = await submit(capture.ref.current);

      expect(result).toBe(true);
      expect(writeConfigDocText).not.toHaveBeenCalled();
      expect(getConfigDoc).not.toHaveBeenCalled();
      expect(patchProfileConfig).toHaveBeenCalledTimes(1);

      const [, mutateFn] = vi.mocked(patchProfileConfig).mock.calls[0]!;
      const cfg: Record<string, unknown> = {};
      mutateFn(cfg);
      expect(cfg.lanes).toEqual(['greenhouse', 'keka']);
    },
  );

  it('a 422 on the document PUT rejects with the server message and never issues the lanes patch', async () => {
    vi.mocked(writeConfigDocText).mockRejectedValue(
      new Error('search_urls.md is invalid: expected a document'),
    );
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(
      0,
      'https://www.linkedin.com/jobs/search/?keywords=frontend',
      'Frontend Roles',
    );

    let rejection: unknown;
    await act(async () => {
      await capture.ref.current!().catch((err) => {
        rejection = err;
      });
    });

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      'search_urls.md is invalid: expected a document',
    );
    expect(patchProfileConfig).not.toHaveBeenCalled();
  });

  it('the freshly seeded template (bullet only mid-sentence, in the format hint) does not trip the never-clobber guard', async () => {
    vi.mocked(getConfigDoc).mockResolvedValue({
      text:
        '# Search URLs\n\n' +
        'Hierarchical: Channel -> page -> labeled URLs. One page-type = one inventory in ' +
        '`src/adapters/lanes/linkedin/page_inventory/<page>.json`; many URLs may live beneath it.\n' +
        'Add URLs with `lane add-url` (strips ephemeral params). Format: `  • <label> - <url>`\n',
    });
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(
      0,
      'https://www.linkedin.com/jobs/search/?keywords=frontend',
      'Frontend Roles',
    );

    const result = await submit(capture.ref.current);

    expect(result).toBe(true);
    expect(screen.queryByTestId('wizard-existing-config')).not.toBeInTheDocument();
    expect(writeConfigDocText).toHaveBeenCalled();
    expect(patchProfileConfig).toHaveBeenCalled();
  });

  it('a pre-existing search_urls.md containing a bullet line shows wizard-existing-config, resolves false, and issues no write request', async () => {
    vi.mocked(getConfigDoc).mockResolvedValue({
      text: '# Search URLs\n\n## linkedin\n### linkedin__jobs-search\n  • Old - https://www.linkedin.com/jobs/search/?keywords=old\n',
    });
    const capture = makeCapture();
    render(<Harness registerSubmit={capture.registerSubmit} />);
    await fillRow(
      0,
      'https://www.linkedin.com/jobs/search/?keywords=frontend',
      'Frontend Roles',
    );

    const result = await submit(capture.ref.current);

    expect(result).toBe(false);
    expect(await screen.findByTestId('wizard-existing-config')).toHaveTextContent(
      'This profile already has search URLs. Edit them in Settings.',
    );
    expect(writeConfigDocText).not.toHaveBeenCalled();
    expect(patchProfileConfig).not.toHaveBeenCalled();
  });
});
