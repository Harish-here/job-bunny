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
    ['#/settings/landing', 'landing'],
    ['#/settings/roles-companies', 'roles-companies'],
    ['#/settings/where-you-work', 'where-you-work'],
    ['#/settings/skills', 'skills'],
    ['#/settings/about-you', 'about-you'],
    ['#/settings/where-jobs-come-from', 'where-jobs-come-from'],
    ['#/settings/schedule', 'schedule'],
    ['#/settings/fetching', 'fetching'],
    ['#/settings/delivery', 'delivery'],
    ['#/settings/housekeeping', 'housekeeping'],
    ['#/settings/raw-config', 'raw-config'],
    ['#/settings/danger', 'danger'],
  ])('%s → settings section %s', (hash, section) => {
    expect(parseHash(hash)).toEqual({ name: 'settings', section });
  });
  test('#/settings with no section defaults to the landing section', () => {
    expect(parseHash('#/settings')).toEqual({ name: 'settings', section: 'landing' });
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
test.each([
  'landing',
  'roles-companies',
  'where-you-work',
  'skills',
  'about-you',
  'where-jobs-come-from',
  'schedule',
  'fetching',
  'delivery',
  'housekeeping',
  'raw-config',
  'danger',
] as const)('routeHash round-trips the %s settings section', (section) => {
  expect(routeHash({ name: 'settings', section })).toBe(`#/settings/${section}`);
});
