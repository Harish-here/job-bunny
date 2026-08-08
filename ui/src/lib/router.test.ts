import { describe, expect, test } from 'vitest';
import { parseHash, routeHash } from './router';

describe('parseHash', () => {
  test.each([
    ['', 'triage'],
    ['#/', 'triage'],
    ['#/nope', 'triage'],
    ['#/triage', 'triage'],
    ['#/tracker', 'tracker'],
    ['#/runs', 'runs'],
    ['#/analytics', 'analytics'],
    ['#/setup', 'setup'],
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
  test.each([
    ['#/settings/profile', 'profile'],
    ['#/settings/schedule', 'schedule'],
    ['#/settings/filters', 'filters'],
    ['#/settings/resume', 'resume'],
    ['#/settings/search-urls', 'search-urls'],
    ['#/settings/danger', 'danger'],
  ])('%s → settings section %s', (hash, section) => {
    expect(parseHash(hash)).toEqual({ name: 'settings', section });
  });
  test('#/settings with no section stays a plain settings route', () => {
    expect(parseHash('#/settings')).toEqual({ name: 'settings' });
  });
  test('#/settings/bogus falls back to a plain settings route', () => {
    expect(parseHash('#/settings/bogus')).toEqual({ name: 'settings' });
  });
});
test('routeHash round-trips a job route', () => {
  expect(routeHash({ name: 'job', id: 'x/y' })).toBe('#/job/x%2Fy');
});
test('routeHash emits a settings section only when the route carries one', () => {
  expect(routeHash({ name: 'settings', section: 'schedule' })).toBe(
    '#/settings/schedule',
  );
  expect(routeHash({ name: 'settings' })).toBe('#/settings');
});
