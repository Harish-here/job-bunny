import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, readActiveProfile, readDraft, writeDraft } from './draftStore';
import type { WizardDraft } from './wizard.types';
import { emptyDraft } from './wizard.types';

const ACTIVE_KEY = 'jobbunny.wizard.active';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readDraft', () => {
  it('returns null when no draft key is stored', () => {
    expect(readDraft('acme')).toBeNull();
  });

  it('round-trips a draft written by writeDraft', () => {
    const draft = emptyDraft('acme');
    writeDraft(draft);
    expect(readDraft('acme')).toEqual(draft);
  });

  it('returns null when the stored value is malformed JSON', () => {
    localStorage.setItem('jobbunny.wizard.v1.acme', '{not json');
    expect(readDraft('acme')).toBeNull();
  });

  it('returns null when the stored payload has the wrong version', () => {
    const draft = { ...emptyDraft('acme'), version: 2 };
    localStorage.setItem('jobbunny.wizard.v1.acme', JSON.stringify(draft));
    expect(readDraft('acme')).toBeNull();
  });

  it('returns null when the stored profile does not match the request', () => {
    const draft = emptyDraft('acme');
    localStorage.setItem('jobbunny.wizard.v1.acme', JSON.stringify(draft));
    expect(readDraft('other')).toBeNull();
  });

  it('returns null when the stored payload is not an object', () => {
    localStorage.setItem('jobbunny.wizard.v1.acme', JSON.stringify('acme'));
    expect(readDraft('acme')).toBeNull();
  });
});

describe('readActiveProfile', () => {
  it('returns null when jobbunny.wizard.active is absent', () => {
    expect(readActiveProfile()).toBeNull();
  });
});

describe('writeDraft', () => {
  it('sets jobbunny.wizard.active to the draft profile', () => {
    writeDraft(emptyDraft('acme'));
    expect(readActiveProfile()).toBe('acme');
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('acme');
  });

  it('does not throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(() => writeDraft(emptyDraft('acme'))).not.toThrow();
  });

  it('keeps two profiles drafts independent', () => {
    const acme: WizardDraft = { ...emptyDraft('acme'), step: 3 };
    const globex: WizardDraft = { ...emptyDraft('globex'), step: 4 };
    writeDraft(acme);
    writeDraft(globex);
    expect(readDraft('acme')).toEqual(acme);
    expect(readDraft('globex')).toEqual(globex);
    expect(readActiveProfile()).toBe('globex');
  });
});

describe('clearDraft', () => {
  it('removes the draft key and the matching active profile', () => {
    writeDraft(emptyDraft('acme'));
    clearDraft('acme');
    expect(readDraft('acme')).toBeNull();
    expect(readActiveProfile()).toBeNull();
  });

  it('leaves a different active profile untouched', () => {
    writeDraft(emptyDraft('acme'));
    writeDraft(emptyDraft('globex'));
    clearDraft('acme');
    expect(readDraft('acme')).toBeNull();
    expect(readActiveProfile()).toBe('globex');
  });
});
