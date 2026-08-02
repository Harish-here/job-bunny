import { describe, expect, test } from 'vitest';
import { parseHash, routeHash } from './router';

describe('parseHash', () => {
  test.each([
    ['', 'triage'],
    ['#/', 'triage'],
    ['#/nope', 'triage'],
    ['#/triage', 'triage'],
    ['#/tracker', 'tracker'],
    ['#/analytics', 'analytics'],
    ['#/onboarding', 'onboarding'],
  ])('%s → %s', (hash, name) => {
    expect(parseHash(hash)).toEqual({ name });
  });
  test('job route with id', () => {
    expect(parseHash('#/job/abc%20d')).toEqual({ name: 'job', id: 'abc d' });
  });
  test('job route without id falls back to triage', () => {
    expect(parseHash('#/job')).toEqual({ name: 'triage' });
  });
});
test('routeHash round-trips', () => {
  expect(routeHash({ name: 'job', id: 'x/y' })).toBe('#/job/x%2Fy');
});
