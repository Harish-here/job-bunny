import { describe, expect, it } from 'vitest';
import { recallSelection, rememberSelection } from './selection-memo';

describe('selection-memo', () => {
  it('recalls null before anything is remembered', () => {
    expect(recallSelection()).toBeNull();
  });

  it('recalls the last remembered id', () => {
    rememberSelection('li-1');
    expect(recallSelection()).toBe('li-1');
    rememberSelection('li-2');
    expect(recallSelection()).toBe('li-2');
  });
});
