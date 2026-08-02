import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FilterConfigSchema } from '../../../core/filter/config.ts';
import { gateCards } from './card_gate.ts';
import type { HarvestedCard } from './harvest.ts';

test('gateCards partitions cards by the card-gate rules and records identity-only JDs for drops', () => {
  const cfg = FilterConfigSchema.parse({
    companies: { avoid: ['Bad Co'] },
  });
  const keeper = {
    title: 'Backend Engineer',
    company: 'Good Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/111/',
    id: 'li-111',
  };
  const dropped = {
    title: 'Backend Engineer',
    company: 'Bad Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/222/',
    id: 'li-222',
  };

  const result = gateCards([keeper, dropped], cfg);

  assert.deepEqual(result.pass, [keeper]);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.identityInvalidCount, 0);
  const record = result.dropped.at(0);
  assert.equal(record?.jd.identity.id, 'li-222');
  assert.equal(record?.jd.identity.lane, 'linkedin');
  assert.equal(record?.jd.identity.company, 'Bad Co');
  assert.equal(record?.jd.identity.title, 'Backend Engineer');
  assert.equal(record?.jd.identity.url, 'https://www.linkedin.com/jobs/view/222/');
  assert.ok(record?.reasons.some((v) => v.rule === 'company.avoid' && v.pass === false));
});

test('gateCards keeps a card when no rule fails (empty FilterConfig ⇒ everything passes)', () => {
  const cfg = FilterConfigSchema.parse({});
  const card = {
    title: 'Anything',
    company: 'Anyone',
    location: 'Anywhere',
    url: 'https://www.linkedin.com/jobs/view/333/',
    id: 'li-333',
  };
  const result = gateCards([card], cfg);
  assert.deepEqual(result.pass, [card]);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.identityInvalidCount, 0);
});

// --- regression, 2026-08-02: a card whose identity is still empty after
// the hydration+settle budget (an intermittent paint race, NOT selector
// drift) must not crash gateCards' internal JDSchema.parse and take the
// whole url down with it (that used to escape uncaught into
// url_runner.ts's whole-url catch, discarding every OTHER card on the
// page too — see run profiles/harish/data/runs/2026-08-02/18-24/).

test('gateCards records an unsettled card (empty title) as its own per-card drop instead of throwing', () => {
  const cfg = FilterConfigSchema.parse({
    companies: { avoid: ['Bad Co'] },
  });
  const keeper: HarvestedCard = {
    title: 'Good Job Title',
    company: 'Good Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/111/',
    id: 'li-111',
  };
  const normalDrop: HarvestedCard = {
    title: 'Fine Title',
    company: 'Bad Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/222/',
    id: 'li-222',
  };
  // Still unsettled when harvested: company matches the avoid list (so
  // this card was always going to be a drop), but its title painted
  // empty — this is the exact shape that used to blow up JDSchema.parse
  // inside gateCards.
  const unsettledDrop: HarvestedCard = {
    title: '',
    company: 'Bad Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/333/',
    id: 'li-333',
  };

  const result = gateCards([keeper, normalDrop, unsettledDrop], cfg);

  assert.deepEqual(result.pass, [keeper]);
  assert.equal(result.dropped.length, 2);
  // Exactly one of the two drops was identity-invalid — the caller
  // (url_runner.ts) uses this count to tell "one unsettled card" apart
  // from "the whole page came back unreadable".
  assert.equal(result.identityInvalidCount, 1);

  const normalRecord = result.dropped.find((r) => r.jd.identity.id === 'li-222');
  assert.ok(normalRecord, 'normalDrop must still be recorded, unaffected by the fix');
  assert.equal(normalRecord?.jd.identity.title, 'Fine Title');
  assert.ok(normalRecord?.reasons.some((v) => v.rule === 'company.avoid' && !v.pass));
  assert.ok(
    !normalRecord?.reasons.some((v) => v.rule === 'linkedin.cardIdentityInvalid'),
    'a card whose identity validated cleanly must not get an identity-invalid reason',
  );

  const unsettledRecord = result.dropped.find((r) => r.jd.identity.id === 'li-333');
  assert.ok(unsettledRecord, 'the unsettled card must be recorded as a drop, not lost');
  // JDSchema requires a non-empty title — gateCards must substitute a
  // placeholder rather than let the empty string escape as a ZodError.
  assert.notEqual(unsettledRecord?.jd.identity.title, '');
  assert.equal(unsettledRecord?.jd.identity.company, 'Bad Co');
  // The pre-existing card-gate reason (company.avoid) is preserved...
  assert.ok(unsettledRecord?.reasons.some((v) => v.rule === 'company.avoid' && !v.pass));
  // ...but PREPENDED by the identity-validation reason: a verdict
  // computed over an empty title is meaningless, so "identity unreadable"
  // is the true reason, and buildFunnel (which groups by each record's
  // FIRST failing verdict) must see it, not company.avoid.
  assert.equal(unsettledRecord?.reasons[0]?.rule, 'linkedin.cardIdentityInvalid');
  const identityReason = unsettledRecord?.reasons.find(
    (v) => v.rule === 'linkedin.cardIdentityInvalid',
  );
  assert.ok(identityReason, 'expected an identity-validation reason for the empty title');
  assert.equal(identityReason?.severity, 'hard');
  assert.equal(identityReason?.pass, false);
  assert.ok(identityReason?.detail && identityReason.detail.length > 0);
});

test('gateCards, on a page where every card fails (including identity validation), still returns an empty pass without throwing', () => {
  const cfg = FilterConfigSchema.parse({
    companies: { avoid: ['Bad Co'] },
    title: { domain: { reject: ['BadWord'] } },
  });
  // Drops via company.avoid; title is the one that's unsettled/empty.
  const emptyTitle: HarvestedCard = {
    title: '',
    company: 'Bad Co',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/444/',
    id: 'li-444',
  };
  // Drops via title.domain's reject list; company is the one that's
  // unsettled/empty.
  const emptyCompany: HarvestedCard = {
    title: 'BadWord Job',
    company: '',
    location: 'Remote',
    url: 'https://www.linkedin.com/jobs/view/555/',
    id: 'li-555',
  };

  const result = gateCards([emptyTitle, emptyCompany], cfg);

  assert.deepEqual(result.pass, []);
  assert.equal(result.dropped.length, 2);
  assert.equal(result.identityInvalidCount, 2);
  for (const record of result.dropped) {
    assert.notEqual(record.jd.identity.title, '');
    assert.notEqual(record.jd.identity.company, '');
    assert.equal(record.reasons[0]?.rule, 'linkedin.cardIdentityInvalid');
  }
});
